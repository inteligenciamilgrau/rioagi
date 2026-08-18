/**
 * World — orquestrador do modulo WORLD.
 *
 *   new World(ctx, { seed })   -> mesma seed, mesmo mapa, sempre.
 *
 * Pipeline de init():
 *   Favela (plano)  ->  terreno  ->  Buildings  ->  Props  ->  Vegetation
 *                   ->  merge/instancing (Batcher)  ->  BVH de colisao
 *                   ->  navGrid  ->  spawns  ->  pontos de cobertura
 *
 * Publica para os outros modulos:
 *   world.collision  (raycast / capsuleSweep / sphereCast)
 *   world.navGrid    (grid 2D de andavel + alturas, consumido pela IA)
 *   world.getSpawnPoints() / world.getCoverPoints()
 *   world.heightAt(x, z)
 * Dono: WORLD.
 */
import * as THREE from 'three';
import { Rng, clamp } from './gen/rng.js';
import { fbm2 } from './gen/noise.js';
import { Batcher } from './gen/batcher.js';
import { resolveMaterials } from './gen/materials.js';
import { TriBuilder } from './gen/geo.js';
import { Favela, TAM_MUNDO, pontoEmObb } from './Favela.js';
import { Buildings } from './Buildings.js';
import { Props } from './Props.js';
import { Vegetation } from './Vegetation.js';
import { Collision } from './Collision.js';
import { Portas } from './Portas.js';

const SEED_PADRAO = 20260728;
const CELULA_NAV = 0.5;

// temporarios de escopo de modulo (sem alocacao por frame)
const _camPos = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/** Hermite 3t^2-2t^3 sobre t ja normalizado em [0,1]. */
function suave01(t) {
  const k = t < 0 ? 0 : (t > 1 ? 1 : t);
  return k * k * (3 - 2 * k);
}

export class World {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.seed = opts.seed ?? SEED_PADRAO;
    this.size = opts.size ?? TAM_MUNDO;
    this.pausable = false;             // o mundo continua vivo com o jogo pausado
    this.rng = new Rng(this.seed);

    this.group = new THREE.Group();
    this.group.name = 'favela';
    this.collision = new Collision();
    this.portas = null;
    this.navGrid = null;
    this._spawns = [];
    this._covers = [];
    this.stats = {};
    this._meshesLod = [];
    this._materiais = null;
    this._bat = null;
  }

  async init() {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const q = this.ctx?.settings?.q ?? null;
    this._materiais = resolveMaterials(this.ctx);
    this._bat = new Batcher(this._materiais, this.size, 3);

    // 1) plano
    this.favela = new Favela(this.seed, { size: this.size }).gerar();
    this.terrain = this.favela.terrain;

    // 2) terreno visual (fora do batcher: usa vertex color para variar terra/mato)
    this._terrenoMesh(q);

    // 3) casas
    this.buildings = new Buildings({
      rng: this.rng.fork('buildings'), batcher: this._bat,
      collision: this.collision, terrain: this.terrain,
    });
    this.buildings.construir(this.favela.casas);

    // 4) props
    this.props = new Props({
      rng: this.rng.fork('props'), batcher: this._bat, collision: this.collision,
      terrain: this.terrain, favela: this.favela, ancoras: this.buildings.ancoras, quality: q,
    });
    this.props.construir();

    // 5) vegetacao
    this.vegetation = new Vegetation({
      rng: this.rng.fork('veg'), batcher: this._bat, collision: this.collision,
      terrain: this.terrain, favela: this.favela, props: this.props,
      ancoras: this.buildings.ancoras, quality: q,
    });
    this.vegetation.construir();

    // 6) merge + instancing
    const bs = this._bat.build(this.group);
    for (const m of this._bat.meshes) if (m.userData.lodMax !== Infinity) this._meshesLod.push(m);

    /* 6b) portas que abrem. Depende do `build()` (precisa dos InstancedMesh) e
     * tem de vir ANTES de `collision.build()` nao por dependencia, mas porque a
     * folha e obstaculo MOVEL: ela nao entra no BVH, entra na lista propria. */
    this.portas = new Portas(this.ctx, this.collision)
      .construir(this.buildings.portas, this.buildings.protoPorta)
      .ligar(this.group);

    // 7) colisao
    this.collision.build();

    // 8) navegacao e pontos de interesse
    this._construirNavGrid();
    this._construirSpawns();
    this._construirCoberturas();

    this.ctx?.scene?.add(this.group);

    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.stats = {
      seed: this.seed,
      casas: this.favela.casas.length,
      vias: this.favela.vias.length,
      postes: this.favela.postes.length,
      muros: this.favela.muros.length,
      fios: this.props.statsFios ?? 0,
      varais: this.props.statsVarais ?? 0,
      arvores: this.vegetation.statsArvores ?? 0,
      capim: this.vegetation.statsCapim ?? 0,
      meshesMerged: bs.merged,
      meshesInstanced: bs.instanced,
      objetosCena: this.group.children.length,
      triangulos: Math.round(bs.triangles + this._trisTerreno),
      trisColisao: this.collision.triangleCount,
      spawns: this._spawns.length,
      coberturas: this._covers.length,
      portas: this.portas.lista.length,
      degrausFuga: this.buildings.statsFuga?.degraus ?? 0,
      telhadosTratados: this.buildings.statsFuga?.tratadas ?? 0,
      cotaMin: +this.favela.cotaMin.toFixed(2),
      cotaMax: +this.favela.cotaMax.toFixed(2),
      msGeracao: Math.round(t1 - t0),
    };
    return this;
  }

  // ------------------------------------------------------------- terreno

  /**
   * Malha visual do terreno.
   *
   * ## O chao do morro e DUAS superficies disputando o mesmo espaco
   * Terra batida (`terra`) e capim ralo (`grama`) sao misturados por pixel no
   * shader, com o peso vindo do vertice (`mistura`). Um morro carioca nao e
   * gramado nem terreiro: e barro vermelho aparecendo entre moita de mato seco,
   * e a fronteira entre os dois e o que da leitura de chao de verdade.
   *
   * ## Tres defeitos que esta funcao ja teve (nao reintroduza)
   * 1. **UV em metros crus.** `uv.push(p[0], p[2])` com `repeat` (1,1) fazia o
   *    ladrilho de `terra` cobrir 1 m, e nao os 2,5 m que o material declara em
   *    `userData.metros`. Toda a variacao macro da textura — que existe para
   *    quebrar o tiling — passava a repetir a cada metro e virava um padrao
   *    reconhecivel. Agora a UV e multiplicada por `escalaUV`, como manda o
   *    contrato de MaterialLibrary.
   * 2. **Um verde chapado.** A cor de vertice era um unico verde (0.55,0.78,0.42)
   *    multiplicando um albedo marrom: o resultado era feltro verde-oliva, e as
   *    manchas escuras da textura viravam rabisco. Agora a cor de vertice e um
   *    tinte QUENTE proximo de 1, com variacao em varias escalas, e quem decide
   *    terra-ou-mato e a `mistura`, nao a cor.
   * 3. **Ruido periodico.** `sin(x*1.7)*cos(z*2.3)` e um xadrez de ~3,7x2,7 m.
   *    Trocado por fBm em tres bandas.
   */
  _terrenoMesh(q) {
    const hf = this.terrain;
    const passo = 1;                                   // 1 m por quad
    const n = Math.round(this.size / passo);
    const setores = 3;
    const porSetor = n / setores;

    const matBase = this._materiais.get('terra');
    const matCapim = this._materiais.get('grama');
    const mat = matBase.clone();
    mat.__cloned = true;
    mat.vertexColors = true;
    mat.color.setRGB(1, 1, 1);
    this._matTerreno = mat;
    this._trisTerreno = 0;
    this._misturarCapim(mat, matBase, matCapim);

    // Contrato de UV: metros de mundo * escalaUV. Sem isto o ladrilho nao tem o
    // tamanho que o material declara.
    const [eu, ev] = matBase.userData?.escalaUV ?? [1, 1];

    // Tres bandas de ruido decorrelacionadas. Nenhuma domina, e nenhuma e
    // periodica — e isso que impede a leitura de padrao.
    const S = this.seed;
    const bMacro = (x, z) => fbm2(x * 0.0115, z * 0.0115, 4, 2.03, 0.5, S + 11);   // ~85 m
    const bMedio = (x, z) => fbm2(x * 0.047, z * 0.047, 3, 2.03, 0.5, S + 307);    // ~21 m
    const bFino = (x, z) => fbm2(x * 0.163, z * 0.163, 2, 2.03, 0.5, S + 911);     // ~6 m

    for (let sz = 0; sz < setores; sz++) {
      for (let sx = 0; sx < setores; sx++) {
        const i0 = sx * porSetor, j0 = sz * porSetor;
        const pos = [], nrm = [], uv = [], col = [], mis = [];
        const P = (i, j) => {
          const x = -this.size / 2 + i * passo;
          const z = -this.size / 2 + j * passo;
          return [x, hf.heightAt(x, z), z];
        };
        for (let j = j0; j < j0 + porSetor; j++) {
          for (let i = i0; i < i0 + porSetor; i++) {
            const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
            // winding anti-horario visto DE CIMA (+Y): com a ordem a,b,c a normal
            // sai para baixo e o terreno inteiro some por backface culling.
            for (const tri of [[a, c, b], [a, d, c]]) {
              const ux = tri[1][0] - tri[0][0], uy = tri[1][1] - tri[0][1], uz = tri[1][2] - tri[0][2];
              const vx = tri[2][0] - tri[0][0], vy = tri[2][1] - tri[0][1], vz = tri[2][2] - tri[0][2];
              let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz2 = ux * vy - uy * vx;
              const L = Math.hypot(nx, ny, nz2) || 1;
              nx /= L; ny /= L; nz2 /= L;
              const decl = 1 - ny;                     // 0 = plano, 1 = parede
              for (const p of tri) {
                pos.push(p[0], p[1], p[2]);
                nrm.push(nx, ny, nz2);
                uv.push(p[0] * eu, p[2] * ev);

                const nM = bMacro(p[0], p[2]), nD = bMedio(p[0], p[2]), nF = bFino(p[0], p[2]);

                // --- terra x capim ---
                // Mato pega onde e suave e onde o ruido deixa; barranco ingreme
                // fica pelado porque a chuva leva a terra solta embora.
                //
                // A base fica ABAIXO de 0,5 de proposito: o morro tem que ler
                // como terra batida com mato por cima, nao como campo com
                // falhas. Com base 0,52 o capim fechava quase todo o plano e o
                // chao virava palheiro uniforme — some a "disputa" entre os dois,
                // que e justamente o que da leitura de encosta carioca.
                let m = 0.34 + nM * 0.40 + nD * 0.30 + nF * 0.18;
                m *= 1 - suave01((decl - 0.09) / 0.26);
                mis.push(clamp(m, 0, 1));

                // --- tinte quente de vertice ---
                // Fica perto de 1: o albedo ja tem a cor certa. Isto so quebra a
                // uniformidade de valor e puxa a paleta para o ambar da capa.
                const val = 1.0 + nM * 0.16 + nD * 0.115 + nF * 0.07;
                // Parte clara puxa para ambar; parte escura, para vermelho fundo.
                const t = clamp((val - 0.84) / 0.32, 0, 1);
                let cr = val * (1.045 + (1 - t) * 0.035);
                let cg = val * (0.985 + t * 0.030);
                let cb = val * (0.905 + t * 0.070);
                // Escarpa muito ingreme = rocha/saibro exposto: mais claro e mais
                // dessaturado, porque ali nao para terra fina nem materia organica.
                if (decl > 0.40) {
                  const k = clamp((decl - 0.40) * 2.4, 0, 1) * 0.55;
                  const cinza = (cr + cg + cb) / 3;
                  cr += (cinza * 1.16 - cr) * k;
                  cg += (cinza * 1.13 - cg) * k;
                  cb += (cinza * 1.06 - cb) * k;
                }
                col.push(cr, cg, cb);
              }
            }
          }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        geo.setAttribute('uv1', new THREE.Float32BufferAttribute(uv.slice(), 2));
        geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        geo.setAttribute('mistura', new THREE.Float32BufferAttribute(mis, 1));
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.name = `terreno:${sx}:${sz}`;
        mesh.receiveShadow = true;
        mesh.castShadow = true;
        mesh.matrixAutoUpdate = false;
        this.group.add(mesh);
        this._trisTerreno += pos.length / 9;
        // colisao: versao decimada (2 m) do mesmo setor
        this._colisaoTerreno(i0, j0, porSetor, passo);
      }
    }
    // saia nas bordas para nao enxergar o vazio
    this._saiaTerreno();
    void q;
  }

  /**
   * Faz o material do terreno misturar `terra` e `grama` por pixel, pesado pelo
   * atributo de vertice `mistura`.
   *
   * A troca e feita por substituicao de substring no shader gerado, e nao
   * reescrevendo os chunks inteiros: assim a alteracao sobrevive a mudanca de
   * versao do three, que reescreve os chunks com frequencia mas mantem a forma
   * `texture2D( <sampler>, <varying> )`. Se algum alvo nao for encontrado, o
   * material continua valido — cai para `terra` puro em vez de quebrar o boot.
   */
  _misturarCapim(mat, matTerra, matCapim) {
    const okTex = matCapim?.map && matTerra?.map && matCapim !== matTerra;
    if (!okTex) return;                       // fallback headless: sem textura, sem mistura

    const alvos = [
      ['map', 'vMapUv', 'mapCapim', matCapim.map],
      ['normalMap', 'vNormalMapUv', 'normalCapim', matCapim.normalMap],
      ['roughnessMap', 'vRoughnessMapUv', 'ormCapimR', matCapim.roughnessMap],
      ['metalnessMap', 'vMetalnessMapUv', 'ormCapimM', matCapim.metalnessMap],
      ['aoMap', 'vAoMapUv', 'ormCapimA', matCapim.aoMap],
    ];

    mat.onBeforeCompile = (shader) => {
      for (const [, , uni, tex] of alvos) if (tex) shader.uniforms[uni] = { value: tex };

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float mistura;\nvarying float vMistura;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMistura = mistura;');

      const decl = alvos.filter((a) => a[3]).map(([, , uni]) => `uniform sampler2D ${uni};`).join('\n');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying float vMistura;\n${decl}`);

      let trocas = 0;
      for (const [sampler, varying, uni, tex] of alvos) {
        if (!tex) continue;
        const de = `texture2D( ${sampler}, ${varying} )`;
        if (!shader.fragmentShader.includes(de)) continue;
        shader.fragmentShader = shader.fragmentShader.replaceAll(
          de, `mix( ${de}, texture2D( ${uni}, ${varying} ), vMistura )`,
        );
        trocas++;
      }
      if (trocas === 0) console.warn('[WORLD] shader do terreno: nenhum alvo de mistura encontrado');
    };
    // Materiais com onBeforeCompile diferente precisam de chave de cache propria.
    mat.customProgramCacheKey = () => 'terreno-terra-capim-v1';
  }

  _colisaoTerreno(i0, j0, tam, passo) {
    const hf = this.terrain;
    const dec = 2;                                     // 1 triangulo de colisao a cada 2 m
    const P = (i, j) => {
      const x = -this.size / 2 + i * passo;
      const z = -this.size / 2 + j * passo;
      return [x, hf.heightAt(x, z), z];
    };
    const arr = new Float32Array((tam / dec) * (tam / dec) * 18);
    let o = 0;
    for (let j = j0; j < j0 + tam; j += dec) {
      for (let i = i0; i < i0 + tam; i += dec) {
        const a = P(i, j), b = P(i + dec, j), c = P(i + dec, j + dec), d = P(i, j + dec);
        for (const tri of [[a, c, b], [a, d, c]]) for (const p of tri) { arr[o++] = p[0]; arr[o++] = p[1]; arr[o++] = p[2]; }
      }
    }
    this.collision.addRaw(arr.subarray(0, o), 'terra');
  }

  _saiaTerreno() {
    const b = new TriBuilder();
    const h = this.size / 2;
    const passo = 4;
    const fundo = this.favela.cotaMin - 25;
    const lados = [
      { fx: (t) => [-h + t, -h], n: [0, 0, -1] },
      { fx: (t) => [h, -h + t], n: [1, 0, 0] },
      { fx: (t) => [h - t, h], n: [0, 0, 1] },
      { fx: (t) => [-h, h - t], n: [-1, 0, 0] },
    ];
    for (const l of lados) {
      for (let t = 0; t < this.size; t += passo) {
        const [x0, z0] = l.fx(t), [x1, z1] = l.fx(t + passo);
        const y0 = this.terrain.heightAt(x0, z0), y1 = this.terrain.heightAt(x1, z1);
        b.quad([x0, y0, z0], [x1, y1, z1], [x1, fundo, z1], [x0, fundo, z0], l.n);
      }
    }
    const geo = b.build();
    const uv = new Float32Array(geo.attributes.position.count * 2);
    const p = geo.attributes.position.array;
    // Mesmo contrato de UV do terreno: metros de mundo * escalaUV.
    const [eu, ev] = this._materiais.get('terra').userData?.escalaUV ?? [1, 1];
    for (let i = 0, k = 0; i < p.length; i += 3, k += 2) {
      uv[k] = (p[i] + p[i + 2]) * eu;
      uv[k + 1] = p[i + 1] * ev;
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('uv1', new THREE.BufferAttribute(uv.slice(), 2));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this._materiais.get('terra'));
    mesh.name = 'terreno:saia';
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
    this._trisTerreno += geo.attributes.position.count / 3;
  }

  // ------------------------------------------------------------ navegacao

  /**
   * navGrid: grid 2D de andavel, construido a partir do PLANO (nao por raycast).
   * E exato porque o mundo inteiro sai daqui: sabemos onde tem casa, muro, poste.
   */
  _construirNavGrid() {
    const cs = CELULA_NAV;
    const w = Math.round(this.size / cs);
    const h = w;
    const data = new Uint8Array(w * h);
    const heightData = new Float32Array(w * h);
    const origin = new THREE.Vector3(-this.size / 2, 0, -this.size / 2);
    const hf = this.terrain;
    const LIM_INCL = 0.62;                              // ~35 graus

    // 1) base: terreno navegavel por inclinacao
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const x = origin.x + (i + 0.5) * cs;
        const z = origin.z + (j + 0.5) * cs;
        const y = hf.heightAt(x, z);
        heightData[j * w + i] = y;
        data[j * w + i] = hf.slopeAt(x, z) < LIM_INCL ? 1 : 0;
      }
    }

    const bloquearObb = (cx, cz, ow, od, yaw, margem = 0) => {
      const R = Math.hypot(ow, od) * 0.5 + margem + cs;
      const i0 = clamp(Math.floor((cx - R - origin.x) / cs), 0, w - 1);
      const i1 = clamp(Math.ceil((cx + R - origin.x) / cs), 0, w - 1);
      const j0 = clamp(Math.floor((cz - R - origin.z) / cs), 0, h - 1);
      const j1 = clamp(Math.ceil((cz + R - origin.z) / cs), 0, h - 1);
      const obb = { x: cx, z: cz, w: ow, d: od, yaw };
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = origin.x + (i + 0.5) * cs, z = origin.z + (j + 0.5) * cs;
        if (pontoEmObb(x, z, obb, margem)) data[j * w + i] = 0;
      }
    };
    const liberarObb = (cx, cz, ow, od, yaw) => {
      const R = Math.hypot(ow, od) * 0.5 + cs;
      const i0 = clamp(Math.floor((cx - R - origin.x) / cs), 0, w - 1);
      const i1 = clamp(Math.ceil((cx + R - origin.x) / cs), 0, w - 1);
      const j0 = clamp(Math.floor((cz - R - origin.z) / cs), 0, h - 1);
      const j1 = clamp(Math.ceil((cz + R - origin.z) / cs), 0, h - 1);
      const obb = { x: cx, z: cz, w: ow, d: od, yaw };
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = origin.x + (i + 0.5) * cs, z = origin.z + (j + 0.5) * cs;
        if (pontoEmObb(x, z, obb, 0)) data[j * w + i] = 1;
      }
    };

    // 2) vias sempre andaveis (sobrescrevem a inclinacao: escadaria e andavel)
    for (const via of this.favela.vias) {
      for (let k = 0; k < via.pts.length; k++) {
        const p = via.pts[k];
        const R = via.w * 0.5;
        const i0 = clamp(Math.floor((p[0] - R - origin.x) / cs), 0, w - 1);
        const i1 = clamp(Math.ceil((p[0] + R - origin.x) / cs), 0, w - 1);
        const j0 = clamp(Math.floor((p[1] - R - origin.z) / cs), 0, h - 1);
        const j1 = clamp(Math.ceil((p[1] + R - origin.z) / cs), 0, h - 1);
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const x = origin.x + (i + 0.5) * cs, z = origin.z + (j + 0.5) * cs;
          if (Math.hypot(x - p[0], z - p[1]) <= R) data[j * w + i] = 1;
        }
      }
    }

    // 3) casas bloqueiam (tunel abre o vao, casa com interior abre o miolo)
    for (const casa of this.favela.casas) {
      bloquearObb(casa.x, casa.z, casa.w, casa.d, casa.yaw, 0.12);
      if (casa.tunel) liberarObb(casa.x, casa.z, casa.w + 1.0, casa.tunelVao - 0.35, casa.yaw);
      else if (casa.interior) liberarObb(casa.x, casa.z, casa.w - 0.75, casa.d - 0.75, casa.yaw);
    }
    /* 3b) o VAO DA PORTA tambem e andavel.
     *
     * Sem isto o miolo liberado acima ficava cercado por um anel bloqueado de
     * uma celula, o BFS de conectividade (passo 5) o considerava inalcancavel e
     * apagava o interior inteiro do navGrid — a IA nunca entrava numa casa e,
     * pior, a malha discordava da colisao, que agora tem o vao aberto. */
    for (const pt of this.buildings.ancoras.portas) {
      if (!pt.casa?.interior) continue;
      const passos = 7;
      for (let k = 0; k <= passos; k++) {
        const t = (k / passos - 0.5) * 2.0;                 // -1 m ate +1 m no eixo da porta
        liberarObb(pt.x + pt.nx * t, pt.z + pt.nz * t, (pt.w ?? 0.9) * 0.7, (pt.w ?? 0.9) * 0.7, 0);
      }
    }
    // 4) muros, postes e volumes de props
    for (const mu of this.favela.muros) bloquearObb(mu.x, mu.z, mu.len, 0.30, mu.yaw, 0.05);
    for (const po of this.favela.postes) bloquearObb(po.x, po.z, 0.4, 0.4, 0, 0.1);
    for (const cv of this.props.pontosCobertura) {
      if (cv.tipo === 'veiculo') bloquearObb(cv.position.x, cv.position.z, 4.3, 1.9, Math.atan2(cv.normal.x, cv.normal.z), 0.1);
    }
    bloquearObb(this.favela.campinho.x, this.favela.campinho.z, 0, 0, 0, 0); // no-op semantico

    // 5) conectividade: tudo que nao alcanca a rua principal vira bloqueado
    const rua = this.favela.vias[0];
    const seedPt = rua.pts[Math.floor(rua.pts.length / 2)];
    const si = clamp(Math.round((seedPt[0] - origin.x) / cs), 0, w - 1);
    const sj = clamp(Math.round((seedPt[1] - origin.z) / cs), 0, h - 1);
    const visto = new Uint8Array(w * h);
    if (data[sj * w + si]) {
      const fila = new Int32Array(w * h);
      let cab = 0, cau = 0;
      fila[cau++] = sj * w + si; visto[sj * w + si] = 1;
      const DEG_MAX = 0.46;
      while (cab < cau) {
        const k = fila[cab++];
        const ki = k % w, kj = (k / w) | 0;
        const hk = heightData[k];
        for (let d = 0; d < 4; d++) {
          const ni = ki + (d === 0 ? 1 : d === 1 ? -1 : 0);
          const nj = kj + (d === 2 ? 1 : d === 3 ? -1 : 0);
          if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
          const nk = nj * w + ni;
          if (visto[nk] || !data[nk]) continue;
          if (Math.abs(heightData[nk] - hk) > DEG_MAX) continue;
          visto[nk] = 1;
          fila[cau++] = nk;
        }
      }
      for (let k = 0; k < data.length; k++) if (!visto[k]) data[k] = 0;
    }

    const self = this;
    this.navGrid = {
      width: w, height: h, cellSize: cs, origin, data, heightData,
      worldToCell(v3, out = { x: 0, z: 0 }) {
        out.x = clamp(Math.floor((v3.x - origin.x) / cs), 0, w - 1);
        out.z = clamp(Math.floor((v3.z - origin.z) / cs), 0, h - 1);
        return out;
      },
      cellToWorld(x, z, out = new THREE.Vector3()) {
        out.set(origin.x + (x + 0.5) * cs, heightData[z * w + x] ?? 0, origin.z + (z + 0.5) * cs);
        return out;
      },
      isWalkable(x, z) {
        if (x < 0 || z < 0 || x >= w || z >= h) return false;
        return data[z * w + x] === 1;
      },
      heightAt(x, z) {
        if (x < 0 || z < 0 || x >= w || z >= h) return 0;
        return heightData[z * w + x];
      },
      /** Celula andavel mais proxima de um ponto do mundo (busca em anel). */
      nearestWalkable(v3, maxRaio = 24, out = { x: 0, z: 0 }) {
        this.worldToCell(v3, out);
        if (this.isWalkable(out.x, out.z)) return out;
        const cx = out.x, cz = out.z;
        for (let r = 1; r <= maxRaio; r++) {
          for (let d = -r; d <= r; d++) {
            const cand = [[cx + d, cz - r], [cx + d, cz + r], [cx - r, cz + d], [cx + r, cz + d]];
            for (const [i, j] of cand) if (this.isWalkable(i, j)) { out.x = i; out.z = j; return out; }
          }
        }
        return null;
      },
      get walkableCount() { let n = 0; for (let i = 0; i < data.length; i++) n += data[i]; return n; },
    };
    void self;
  }

  /**
   * Pontos de nascimento espalhados por DISCO DE POISSON.
   *
   * A versão anterior usava amostragem do ponto mais distante, que MAXIMIZA a
   * separação — o resultado eram 18 pontos empurrados para as bordas do mapa,
   * com o mais próximo do jogador a 40 m e nenhum no miolo da favela. Poisson
   * garante só uma distância MÍNIMA e aceita qualquer candidato que a respeite,
   * o que enche o mapa por igual.
   */
  _construirSpawns() {
    const r = this.rng.fork('spawns');
    const ng = this.navGrid;
    const cands = [];
    // amostra mais fina que antes: passo 2 em vez de 3, para haver candidato
    // suficiente no miolo apertado dos becos
    for (let j = 3; j < ng.height - 3; j += 2) {
      for (let i = 3; i < ng.width - 3; i += 2) {
        if (!ng.isWalkable(i, j)) continue;
        let livres = 0;
        for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) if (ng.isWalkable(i + di, j + dj)) livres++;
        if (livres < 19) continue;
        cands.push([i, j]);
      }
    }
    if (!cands.length) return;
    r.shuffle(cands);

    const N_SPAWN = 80;
    /* Separação mínima em CÉLULAS (cellSize = 0,5 m). 14 células = 7 m: perto o
     * bastante para haver sempre um ponto a poucos segundos de qualquer lugar,
     * longe o bastante para dois inimigos não nascerem em cima um do outro. */
    let sepMin = 14;
    const escolhidos = [];

    // Duas passadas: a primeira com a separação alvo; se o mapa não comportar
    // N_SPAWN pontos, a segunda relaxa e completa. Assim mapas apertados não
    // ficam com meia dúzia de spawns.
    for (let passada = 0; passada < 2 && escolhidos.length < N_SPAWN; passada++) {
      const sep2 = sepMin * sepMin;
      for (const c of cands) {
        if (escolhidos.length >= N_SPAWN) break;
        let ok = true;
        for (const e of escolhidos) {
          if ((c[0] - e[0]) ** 2 + (c[1] - e[1]) ** 2 < sep2) { ok = false; break; }
        }
        if (ok) escolhidos.push(c);
      }
      sepMin = Math.max(8, Math.floor(sepMin * 0.65));
    }
    const tmp = new THREE.Vector3();
    for (const [i, j] of escolhidos) {
      ng.cellToWorld(i, j, tmp);
      /* Olha para o centro do mapa, com desvio.
       *
       * ATENCAO — ESTE YAW ESTA NA CONVENCAO DO INIMIGO, NAO NA DA CAMERA.
       * O jogo tem DUAS convencoes de yaw, opostas em 180 graus:
       *
       *   inimigo (Enemy.js)  frente = ( +sin yaw, 0, +cos yaw )
       *   camera  (CameraRig) frente = ( -sin yaw, 0, -cos yaw )
       *
       * A do inimigo vem de `grupo.rotation.y = yaw` com a malha do soldado
       * olhando para +Z; a da camera vem do -Z padrao do THREE.PerspectiveCamera.
       * Quem consome estes pontos e o AIManager, entao a formula certa AQUI e
       * atan2(-x, -z) — na convencao do inimigo isso aponta para a origem.
       *
       * NAO "corrija" o sinal: parece invertido quando lido com a cabeca na
       * convencao da camera, mas trocar vira todo inimigo de costas no spawn.
       * O Player NAO usa este yaw justamente por isso (ver Player._rumoInicial).
       */
      const yaw = Math.atan2(-tmp.x, -tmp.z) + r.range(-0.7, 0.7);
      this._spawns.push({ position: new THREE.Vector3(tmp.x, tmp.y + 0.05, tmp.z), yaw });
    }
  }

  /**
   * Cobertura: quinas de casa e o que Props ja marcou (muro, veiculo, balcao).
   * CONVENCAO: `position` e onde o agente fica (celula andavel) e `normal` aponta
   * PARA FORA da cobertura — ou seja, para o lado exposto. Andar em -normal a
   * partir de position encosta na parede.
   */
  _construirCoberturas() {
    const ng = this.navGrid;
    const cel = { x: 0, z: 0 };
    const push = (px, pz, nx, nz, altura, tipo) => {
      _v2.set(px, 0, pz);
      ng.worldToCell(_v2, cel);
      if (!ng.isWalkable(cel.x, cel.z)) return;
      const y = ng.heightAt(cel.x, cel.z);
      this._covers.push({
        position: new THREE.Vector3(px, y, pz),
        normal: new THREE.Vector3(nx, 0, nz).normalize(),
        altura, tipo,
      });
    };
    // quinas de casa: o classico "peek de esquina"
    for (const casa of this.favela.casas) {
      const c = Math.cos(casa.yaw), s = Math.sin(casa.yaw);
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const lx = sx * (casa.w * 0.5 + 0.7), lz = sz * (casa.d * 0.5 + 0.7);
        const px = casa.x + lx * c + lz * s, pz = casa.z - lx * s + lz * c;
        // normal para fora da casa: -normal leva de volta para a quina
        push(px, pz, px - casa.x, pz - casa.z, 2.2, 'quina');
      }
    }
    for (const cv of this.props.pontosCobertura) {
      push(cv.position.x, cv.position.z, cv.normal.x, cv.normal.z, cv.altura, cv.tipo);
    }
  }

  // ------------------------------------------------------------------ API

  getSpawnPoints() { return this._spawns; }
  getCoverPoints() { return this._covers; }

  /** Altura do terreno (nao inclui laje/telhado — use collision.raycast para isso). */
  heightAt(x, z) { return this.terrain.heightAt(x, z); }

  /** Alterna wireframe em tudo (usado pelo debug/teste). */
  setWireframe(on) {
    const vistos = new Set();
    this.group.traverse((o) => {
      if (!o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) { if (vistos.has(m)) continue; vistos.add(m); m.wireframe = on; }
    });
  }

  setQuality(preset) {
    // densidade so muda em regeneracao; o que da para ajustar em tempo real e o LOD
    this._lodEscala = preset?.vegetationDensity ?? 1;
  }

  /** LOD por distancia da camera nos lotes de props miudos. */
  update(dt, elapsed) {
    // as portas giram mesmo com o jogo pausado? nao: `pausable` do World e false,
    // entao este update roda sempre — o giro usa dt, e um dt de menu nao machuca.
    this.portas?.update(dt);
    const cam = this.ctx?.camera;
    if (!cam || !this._meshesLod.length) return;
    cam.getWorldPosition(_camPos);
    const k = this._lodEscala ?? 1;
    for (let i = 0; i < this._meshesLod.length; i++) {
      const m = this._meshesLod[i];
      const c = m.userData.centro;
      const d = Math.hypot(_camPos.x - c.x, _camPos.y - c.y, _camPos.z - c.z) - m.userData.raio;
      m.visible = d < m.userData.lodMax * k;
    }
    void dt; void elapsed;
  }

  dispose() {
    this.group.traverse((o) => { o.geometry?.dispose?.(); });
    const mats = new Set();
    this.group.traverse((o) => { if (o.material) mats.add(o.material); });
    for (const m of mats) if (m.__cloned) m.dispose();
    this.ctx?.scene?.remove(this.group);
    this.group.clear();
    this.portas?.dispose();
    this.portas = null;
    this.collision.dispose();
    if (this._materiais?.isFallback) this._materiais.dispose();
    this._meshesLod.length = 0;
    this._spawns.length = 0;
    this._covers.length = 0;
    this.navGrid = null;
  }
}

export default World;
