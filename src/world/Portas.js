/**
 * Portas — as folhas de porta que ABREM de verdade. Dono: WORLD.
 *
 * Existe porque a favela tinha casa com interior jogavel e sem saida: a malha
 * visual desenhava o vao, a colisao nao sabia dele, e quem entrava (ou nascia)
 * la dentro ficava preso. Consertado o vao na colisao (`Buildings._colParede`),
 * faltava a folha: porta que se ve fechada e se atravessa e pior que porta
 * trancada, porque mente sobre o mundo.
 *
 * ## As tres pecas andam JUNTAS
 *  1. **visual** — cada folha e uma instancia do `InstancedMesh` de porta, com a
 *     dobradica na origem do prototipo. Girar = reescrever a matriz da instancia.
 *  2. **colisao** — a mesma folha e uma caixa orientada movel em `Collision`
 *     (`addObstaculo`), com o MESMO yaw. Nao ha estado "aberta" na colisao: ela
 *     le o angulo atual. Porta pela metade barra pela metade.
 *  3. **som** — `AudioEngine.porta(fase, pos)`, procedural como todo o resto.
 *
 * O angulo e a unica fonte de verdade. Se algum dia a animacao e a colisao
 * divergirem, e porque alguem passou a guardar `aberta: true` em vez de ler
 * `ang` — nao facam isso.
 *
 * ## Mira, e nao raio
 * `alvoNaMira` faz travessia de raio contra a caixa da folha (com folga de
 * mira), e nao "porta mais proxima num raio de 2 m". Num corredor com duas
 * portas de frente uma para a outra, o raio abre a errada.
 */
import * as THREE from 'three';

/** Quanto a folha gira ao abrir. 83 graus: nao encosta na parede nem no batente. */
const ABERTURA = Math.PI * 0.46;
/** Tempo do giro, em segundos. Curto — porta de favela nao e portao de castelo. */
const TEMPO_GIRO = 0.42;
/** Alcance da acao, em metros (~2 m: braco esticado, nao telecinese). */
export const ALCANCE_ACAO = 2.1;
/** Folga somada a caixa SO para mirar (nao vale para colisao). */
const FOLGA_MIRA = 0.16;

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _esc = new THREE.Vector3();

export class Portas {
  /**
   * @param {object} ctx GameContext (usa ctx.bus e ctx.audio; ambos opcionais)
   * @param {import('./Collision.js').Collision} collision
   */
  constructor(ctx, collision) {
    this.ctx = ctx;
    this.col = collision;
    this.lista = [];
    this._meshes = new Map();       // nome de instancia -> InstancedMesh
    this._animando = [];            // portas com giro em andamento
    this._protoW = 0.86;            // preenchido por `registrar`
    this._protoH = 2.07;
  }

  /**
   * @param {object[]} defs saida de `Buildings.portas`
   * @param {{w:number,h:number}} proto tamanho do prototipo instanciado
   */
  construir(defs, proto) {
    this._protoW = proto.w; this._protoH = proto.h;
    for (const d of defs) {
      if (!d || d.idx < 0) continue;
      const p = {
        inst: d.inst, idx: d.idx,
        eixo: d.eixo,
        yawBase: d.yawBase, sentido: d.sentido,
        w: d.w, h: d.h, esp: d.esp,
        nx: d.nx, nz: d.nz,
        casa: d.casa,
        ang: 0, alvo: 0,
        obb: null,
      };
      /* A caixa de colisao nasce ancorada no EIXO (que nao anda) e com alcance
       * igual a largura da folha: assim a busca por vizinhanca acha a porta em
       * qualquer angulo, inclusive no meio do giro. */
      p.obb = this.col.addObstaculo({
        x: d.eixo.x, y: d.eixo.y + d.h * 0.5, z: d.eixo.z,
        w: d.w, h: d.h, d: d.esp, yaw: d.yawBase,
        ancoraX: d.eixo.x, ancoraZ: d.eixo.z, alcance: d.w + 0.2,
      });
      this._aplicar(p);
      this.lista.push(p);
    }
    return this;
  }

  /** Liga a lista as malhas instanciadas ja construidas pelo Batcher. */
  ligar(group) {
    group.traverse((o) => {
      if (o.isInstancedMesh && o.name.startsWith('inst:porta')) {
        this._meshes.set(o.name.slice(5), o);
      }
    });
    // primeira escrita: garante que malha e colisao partem do mesmo angulo
    for (const p of this.lista) this._aplicar(p);
    return this;
  }

  /** Escreve o angulo atual na instancia visual E na caixa de colisao. */
  _aplicar(p) {
    const yaw = p.yawBase + p.ang * p.sentido;
    const c = Math.cos(yaw), s = Math.sin(yaw);

    // centro da folha = eixo + meia largura ao longo do +X local
    p.obb.x = p.eixo.x + c * p.w * 0.5;
    p.obb.z = p.eixo.z - s * p.w * 0.5;
    p.obb.y = p.eixo.y + p.h * 0.5;
    p.obb.yaw = yaw;

    const im = this._meshes.get(p.inst);
    if (!im || p.idx >= im.count) return;
    _m.makeRotationY(yaw);
    _m.setPosition(p.eixo.x, p.eixo.y, p.eixo.z);
    _m.scale(_esc.set(p.w / this._protoW, p.h / this._protoH, 1));
    im.setMatrixAt(p.idx, _m);
    im.instanceMatrix.needsUpdate = true;
  }

  /**
   * Porta que o jogador esta MIRANDO, dentro do alcance.
   * @param {THREE.Vector3} origem olho
   * @param {THREE.Vector3} dir direcao de mira (unitaria)
   * @returns {object|null}
   */
  alvoNaMira(origem, dir, alcance = ALCANCE_ACAO) {
    let melhor = null, melhorD = Infinity;
    for (let i = 0; i < this.lista.length; i++) {
      const p = this.lista[i];
      // descarte barato pelo eixo antes de fazer conta de raio
      const dx = p.eixo.x - origem.x, dz = p.eixo.z - origem.z;
      const lim = alcance + p.w + 0.5;
      if (dx * dx + dz * dz > lim * lim) continue;
      if (Math.abs(p.eixo.y + p.h * 0.5 - origem.y) > p.h * 0.5 + alcance) continue;
      const t = this._raioCaixa(origem, dir, p.obb, alcance);
      if (t < 0 || t >= melhorD) continue;
      melhor = p; melhorD = t;
    }
    if (!melhor) return null;

    /* Parede na frente? A folha vive fora do BVH, entao um raio que atravessa
     * alvenaria e chega na porta do outro comodo passaria batido. */
    const h = this.col?.raycast?.(origem, dir, melhorD);
    if (h && h.hit && h.distance < melhorD - 0.05) return null;
    return melhor;
  }

  /** Travessia raio x caixa orientada (slab). Devolve t ou -1. */
  _raioCaixa(origem, dir, ob, maxT) {
    const c = Math.cos(ob.yaw), s = Math.sin(ob.yaw);
    const dx = origem.x - ob.x, dz = origem.z - ob.z;
    const ox = dx * c - dz * s, oz = dx * s + dz * c;
    const oy = origem.y - ob.y;
    const rx = dir.x * c - dir.z * s, rz = dir.x * s + dir.z * c;
    const ry = dir.y;

    const h = [ob.hw + FOLGA_MIRA, ob.hh, ob.hd + FOLGA_MIRA];
    const o = [ox, oy, oz], d = [rx, ry, rz];
    let t0 = 0, t1 = maxT;
    for (let k = 0; k < 3; k++) {
      if (Math.abs(d[k]) < 1e-8) {
        if (Math.abs(o[k]) > h[k]) return -1;
        continue;
      }
      const inv = 1 / d[k];
      let a = (-h[k] - o[k]) * inv, b = (h[k] - o[k]) * inv;
      if (a > b) { const t = a; a = b; b = t; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) return -1;
    }
    return t0;
  }

  /**
   * Abre (ou fecha) a folha. Devolve o que aconteceu, para o HUD/audio.
   * @returns {'abrindo'|'fechando'|null}
   */
  acionar(p) {
    if (!p) return null;
    const abrindo = p.alvo < ABERTURA * 0.5;
    p.alvo = abrindo ? ABERTURA : 0;
    if (!this._animando.includes(p)) this._animando.push(p);
    const pos = _v.set(p.eixo.x, p.eixo.y + p.h * 0.5, p.eixo.z);
    this.ctx?.audio?.porta?.(abrindo ? 'abre' : 'fecha', pos);
    this.ctx?.bus?.emit?.('porta:acionada', { abrindo, position: pos.clone() });
    return abrindo ? 'abrindo' : 'fechando';
  }

  /** Giro por quadro. So mexe no que esta animando — custo zero em repouso. */
  update(dt) {
    if (!this._animando.length) return;
    const passo = (ABERTURA / TEMPO_GIRO) * dt;
    for (let i = this._animando.length - 1; i >= 0; i--) {
      const p = this._animando[i];
      const falta = p.alvo - p.ang;
      if (Math.abs(falta) <= passo) {
        p.ang = p.alvo;
        this._aplicar(p);
        this._animando.splice(i, 1);
        // batente/trinco no fim do curso: e o que da peso ao movimento
        if (p.ang === 0) {
          this.ctx?.audio?.porta?.('bate', _v.set(p.eixo.x, p.eixo.y + p.h * 0.5, p.eixo.z));
        }
        continue;
      }
      p.ang += Math.sign(falta) * passo;
      this._aplicar(p);
    }
  }

  dispose() {
    this.lista.length = 0;
    this._animando.length = 0;
    this._meshes.clear();
  }
}

export { ABERTURA };
