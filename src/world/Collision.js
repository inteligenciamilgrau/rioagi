/**
 * Collision — malha de colisao SIMPLIFICADA (separada da visual) indexada por BVH.
 *
 * A visual tem chanfro, telha ondulada, grade de janela. Nada disso entra aqui:
 * a colisao e feita de caixas e planos grosseiros, com uma etiqueta de superficie
 * por triangulo (usada por FX/AUDIO via `weapon:hit`).
 *
 * API publica (contrato ARCHITECTURE.md):
 *   raycast(origin, dir, maxDist)            -> {hit, point, normal, surface, distance}
 *   capsuleSweep(start, end, radius, height) -> {position, grounded, normal, ...}
 *   sphereCast(origin, dir, radius, maxDist) -> {hit, point, normal, surface, distance}
 *
 * ## Obstaculos MOVEIS (folha de porta)
 * O BVH e estatico por construcao — reordena o index no build e nao aceita
 * geometria que anda. Uma porta que gira no batente precisa de colisao que gire
 * junto, senao ela abre na tela e continua barrando (que e pior que porta
 * trancada: o jogador insiste). Por isso a folha vive FORA do BVH, como caixa
 * orientada consultada a parte pela capsula — ver `addObstaculo` e
 * `_empurraDaCaixa`. Sao poucas dezenas e so as vizinhas sao testadas.
 *
 * O obstaculo movel NAO entra em `raycast`: bala e linha de visada continuam
 * atravessando a folha. E uma limitacao consciente — mexer no raycast mudaria o
 * contrato de `faceIndex`/`surface` que FX, AUDIO e a IA consomem.
 * Dono: WORLD.
 */
import * as THREE from 'three';
import { MeshBVH, SAH, INTERSECTED, NOT_INTERSECTED } from 'three-mesh-bvh';

const SUPERFICIES = ['concreto', 'tijolo', 'metal', 'madeira', 'vidro', 'terra', 'asfalto', 'agua', 'folhagem'];

/** Acima deste normal.y a superficie e considerada piso (≈60°), nao parede.
 *  Mesmo limiar usado por _sondaChao, para depenetracao e teste de chao
 *  concordarem — se divergirem, o jogador fica "no chao" mas e empurrado. */
const CHAO_PISAVEL_Y = 0.5;
const IDX_SUP = new Map(SUPERFICIES.map((s, i) => [s, i]));

// --- temporarios de escopo de modulo: zero alocacao por frame ---
const _ray = new THREE.Ray();
const _dir = new THREE.Vector3();
const _v0 = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3();
const _seg = new THREE.Line3();
const _box = new THREE.Box3();
const _triPt = new THREE.Vector3(), _capPt = new THREE.Vector3();
const _push = new THREE.Vector3();
const _tmpA = new THREE.Vector3(), _tmpB = new THREE.Vector3();
const _pos = new THREE.Vector3(), _delta = new THREE.Vector3();
const _posAlt = new THREE.Vector3();
const _normalAcc = new THREE.Vector3();
const _hitPt = new THREE.Vector3();
const _closest = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };

const RESULTADO_MISS = Object.freeze({ hit: false, point: null, normal: null, surface: null, distance: Infinity });

export class Collision {
  constructor() {
    this._chunks = [];         // {pos: Float32Array, surf: number}
    this._triCount = 0;
    this.geometry = null;
    this.bvh = null;
    this.faceSurface = null;   // Uint8Array, indice em SUPERFICIES por triangulo
    this.built = false;
    /* Obstaculos moveis (folhas de porta). `_perto` e recolhido uma vez por
     * capsuleSweep e reusado pelas 4 iteracoes de depenetracao. */
    this.obstaculos = [];
    this._perto = [];
    // buffers reutilizados pelos retornos (a API devolve o mesmo objeto por chamada)
    this._rc = { hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(), surface: null, distance: 0, faceIndex: -1 };
    this._sc = { hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(), surface: null, distance: 0 };
    this._cs = {
      position: new THREE.Vector3(), grounded: false, normal: new THREE.Vector3(0, 1, 0),
      groundNormal: new THREE.Vector3(0, 1, 0), hitWall: false, stepped: false, surface: 'concreto',
    };
  }

  // ---------------------------------------------------------------- montagem

  /** Adiciona posicoes cruas (Float32Array de triangulos nao indexados, ja em mundo). */
  addRaw(positions, surface) {
    if (!positions || positions.length < 9) return;
    this._chunks.push({ pos: positions, surf: IDX_SUP.get(surface) ?? 0 });
    this._triCount += positions.length / 9;
  }

  /** Adiciona uma BufferGeometry (indexada ou nao), opcionalmente transformada. */
  addGeometry(geo, matrix, surface) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const src = g.attributes.position.array;
    const out = new Float32Array(src.length);
    if (matrix) {
      for (let i = 0; i < src.length; i += 3) {
        _v0.set(src[i], src[i + 1], src[i + 2]).applyMatrix4(matrix);
        out[i] = _v0.x; out[i + 1] = _v0.y; out[i + 2] = _v0.z;
      }
    } else out.set(src);
    this.addRaw(out, surface);
    if (g !== geo) g.dispose();
  }

  /** Caixa orientada em Y — a primitiva de colisao dominante (paredes, lajes, muros). */
  addBox(cx, cy, cz, w, h, d, yaw, surface) {
    const hw = w * 0.5, hh = h * 0.5, hd = d * 0.5;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const P = [];
    for (const sy of [-1, 1]) for (const sz of [-1, 1]) for (const sx of [-1, 1]) {
      const x = sx * hw, z = sz * hd;
      P.push([cx + x * c + z * s, cy + sy * hh, cz - x * s + z * c]);
    }
    // indices dos 8 cantos: bit0=x, bit1=z, bit2=y
    const q = (a, b, cc, dd) => [P[a], P[b], P[cc], P[a], P[cc], P[dd]];
    const faces = [
      q(0, 1, 3, 2), q(4, 6, 7, 5),          // -Y, +Y
      q(0, 4, 5, 1), q(2, 3, 7, 6),          // -Z, +Z
      q(0, 2, 6, 4), q(1, 5, 7, 3),          // -X, +X
    ];
    const arr = new Float32Array(faces.length * 6 * 3);
    let o = 0;
    for (const f of faces) for (const p of f) { arr[o++] = p[0]; arr[o++] = p[1]; arr[o++] = p[2]; }
    this.addRaw(arr, surface);
  }

  /** Constroi a geometria unica + BVH. Chamar uma vez, no fim da geracao. */
  build() {
    const total = this._triCount * 9;
    const pos = new Float32Array(total);
    const surf = new Uint8Array(this._triCount);
    let o = 0, t = 0;
    for (const ch of this._chunks) {
      pos.set(ch.pos, o);
      const n = ch.pos.length / 9;
      surf.fill(ch.surf, t, t + n);
      o += ch.pos.length; t += n;
    }
    this._chunks.length = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.computeBoundingBox();
    this.geometry = geo;
    this.faceSurface = surf;
    this.bvh = new MeshBVH(geo, { strategy: SAH, targetLeafSize: 8 });
    this.built = true;
    return this;
  }

  get triangleCount() { return this._triCount; }

  // ---------------------------------------------------------------- consultas

  /**
   * ATENCAO: `MeshBVH` cria e REORDENA o index da geometria durante o build.
   * O `faceIndex` devolvido pelo raycast e a posicao no index reordenado, nao o
   * triangulo original. Ler `position[faceIndex*9]` direto devolve vertices de
   * triangulos aleatorios (normais degeneradas, superficie errada). Tudo abaixo
   * passa pelo index para voltar ao triangulo certo.
   */
  _vertIndex(fi) {
    const idx = this.geometry.index;
    return idx ? idx.getX(fi * 3) : fi * 3;
  }

  /** Normal geometrica do triangulo `fi`, escrita em `out`. */
  _faceNormal(fi, out) {
    const p = this.geometry.attributes.position.array;
    const i = this._vertIndex(fi) * 3;
    _v0.set(p[i], p[i + 1], p[i + 2]);
    _v1.set(p[i + 3], p[i + 4], p[i + 5]);
    _v2.set(p[i + 6], p[i + 7], p[i + 8]);
    _e1.subVectors(_v1, _v0); _e2.subVectors(_v2, _v0);
    out.crossVectors(_e1, _e2);
    if (out.lengthSq() < 1e-16) return out.set(0, 1, 0);   // triangulo degenerado
    return out.normalize();
  }

  /** Superficie do triangulo `fi` (a tabela e indexada pelo triangulo ORIGINAL). */
  surfaceOfFace(fi) {
    const orig = (this._vertIndex(fi) / 3) | 0;
    return SUPERFICIES[this.faceSurface[orig]] || 'concreto';
  }

  /**
   * Raycast contra o mundo.
   * @returns {{hit:boolean, point:THREE.Vector3, normal:THREE.Vector3, surface:string, distance:number}}
   */
  raycast(origin, dir, maxDist = 1000) {
    if (!this.built) return RESULTADO_MISS;
    _dir.copy(dir).normalize();
    _ray.origin.copy(origin);
    _ray.direction.copy(_dir);
    const hit = this.bvh.raycastFirst(_ray, THREE.DoubleSide, 0, maxDist);
    const r = this._rc;
    if (!hit) { r.hit = false; r.distance = Infinity; r.surface = null; r.faceIndex = -1; return r; }
    r.hit = true;
    r.point.copy(hit.point);
    r.distance = hit.distance;
    r.faceIndex = hit.faceIndex;
    this._faceNormal(hit.faceIndex, r.normal);
    if (r.normal.dot(_dir) > 0) r.normal.negate();   // sempre apontando para o atirador
    r.surface = this.surfaceOfFace(hit.faceIndex);
    return r;
  }

  /** Altura do chao em (x,z), varrendo de cima para baixo. -Infinity se nao houver. */
  groundAt(x, z, fromY = 200, maxDist = 400) {
    _tmpA.set(x, fromY, z); _tmpB.set(0, -1, 0);
    const r = this.raycast(_tmpA, _tmpB, maxDist);
    return r.hit ? r.point.y : -Infinity;
  }

  /**
   * Sphere cast por marcha + refino. Suficiente para granadas e testes de volume
   * da IA; nao pretende ser um sweep analitico exato.
   */
  sphereCast(origin, dir, radius, maxDist = 100) {
    const out = this._sc;
    out.hit = false; out.distance = Infinity; out.surface = null;
    if (!this.built) return out;
    _dir.copy(dir).normalize();
    const step = Math.max(0.05, radius * 0.75);
    let d = 0, prev = 0;
    while (d <= maxDist) {
      _tmpA.copy(origin).addScaledVector(_dir, d);
      const res = this.bvh.closestPointToPoint(_tmpA, _closest, 0, radius);
      if (res) {
        // refino por bisseccao entre `prev` (livre) e `d` (penetrado)
        let lo = prev, hi = d;
        for (let i = 0; i < 6; i++) {
          const mid = (lo + hi) * 0.5;
          _tmpB.copy(origin).addScaledVector(_dir, mid);
          if (this.bvh.closestPointToPoint(_tmpB, _closest, 0, radius)) hi = mid; else lo = mid;
        }
        _tmpB.copy(origin).addScaledVector(_dir, hi);
        this.bvh.closestPointToPoint(_tmpB, _closest, 0, radius * 1.2);
        out.hit = true;
        out.distance = hi;
        out.point.copy(_closest.point);
        this._faceNormal(_closest.faceIndex, out.normal);
        if (out.normal.dot(_dir) > 0) out.normal.negate();
        out.surface = this.surfaceOfFace(_closest.faceIndex);
        return out;
      }
      prev = d;
      d += step;
    }
    return out;
  }

  // -------------------------------------------------- obstaculos moveis

  /**
   * Registra uma caixa orientada que PODE se mexer depois (folha de porta).
   * Devolve o proprio objeto: quem o criou escreve `x/y/z/yaw/ativo` a vontade
   * e a colisao acompanha no quadro seguinte, sem reconstruir nada.
   *
   * `ancoraX/ancoraZ` e o ponto FIXO usado na busca por vizinhanca (o batente,
   * no caso da porta). Usar o centro da caixa nao serviria: ele anda quando a
   * folha gira, e ai o obstaculo sairia do alcance da consulta bem no meio do
   * giro.
   *
   * @returns {{x,y,z,hw,hh,hd,yaw,ativo,ancoraX,ancoraZ,alcance}}
   */
  addObstaculo(o) {
    const ob = {
      x: o.x, y: o.y, z: o.z,
      hw: o.w * 0.5, hh: o.h * 0.5, hd: o.d * 0.5,
      yaw: o.yaw ?? 0,
      ativo: o.ativo !== false,
      ancoraX: o.ancoraX ?? o.x,
      ancoraZ: o.ancoraZ ?? o.z,
      // raio que a caixa alcanca a partir da ancora, girando como girar
      alcance: (o.alcance ?? Math.hypot(o.w, o.d) * 0.5) + 0.05,
    };
    this.obstaculos.push(ob);
    return ob;
  }

  /** Obstaculos cujo alcance encosta na vizinhanca de (x,z). */
  _coletarObstaculos(x, z, raio) {
    const out = this._perto;
    out.length = 0;
    const lista = this.obstaculos;
    for (let i = 0; i < lista.length; i++) {
      const ob = lista[i];
      if (!ob.ativo) continue;
      const dx = ob.ancoraX - x, dz = ob.ancoraZ - z;
      const r = raio + ob.alcance;
      if (dx * dx + dz * dz <= r * r) out.push(ob);
    }
    return out;
  }

  /**
   * Empurra a capsula (segmento VERTICAL de `y0` a `y1`, raio `radius`) para
   * fora de uma caixa orientada. Devolve a profundidade resolvida (0 = sem toque).
   *
   * O segmento e vertical sempre, entao a distancia caixa-capsula se separa por
   * eixo no referencial da caixa e sai exata, sem iteracao. So empurra na
   * HORIZONTAL: resolver na vertical faria o jogador subir em cima da folha da
   * porta como se fosse degrau.
   */
  _empurraDaCaixa(pos, radius, height, ob, out) {
    const c = Math.cos(ob.yaw), s = Math.sin(ob.yaw);
    const dx = pos.x - ob.x, dz = pos.z - ob.z;
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    const y0 = pos.y + radius - ob.y, y1 = pos.y + height - radius - ob.y;

    const ax = Math.abs(lx) - ob.hw;
    const az = Math.abs(lz) - ob.hd;
    // folga vertical entre o segmento [y0,y1] e a caixa [-hh, hh]
    const ay = Math.max(y0 - ob.hh, -ob.hh - y1, 0);
    if (ay > 0) {
      // ainda pode tocar pela quina, mas so se a distancia total couber no raio
      const px = Math.max(ax, 0), pz = Math.max(az, 0);
      if (px * px + pz * pz + ay * ay >= radius * radius) return 0;
    }

    if (ax > 0 || az > 0) {
      const px = Math.max(ax, 0), pz = Math.max(az, 0);
      const d2 = px * px + pz * pz + ay * ay;
      if (d2 >= radius * radius) return 0;
      const d = Math.sqrt(d2);
      // direcao horizontal de saida (a componente vertical e descartada de proposito)
      let ex = ax > 0 ? Math.sign(lx) * px : 0;
      let ez = az > 0 ? Math.sign(lz) * pz : 0;
      if (ex === 0 && ez === 0) ez = Math.sign(lz) || 1;
      const el = Math.hypot(ex, ez) || 1;
      ex /= el; ez /= el;
      const prof = radius - d + 1e-4;
      out.set(ex * c + ez * s, 0, -ex * s + ez * c);
      pos.x += out.x * prof; pos.z += out.z * prof;
      return prof;
    }

    // eixo do jogador DENTRO da planta da caixa: sai pela face mais proxima
    const penX = ob.hw + radius - Math.abs(lx);
    const penZ = ob.hd + radius - Math.abs(lz);
    let ex = 0, ez = 0, prof;
    if (penZ <= penX) { ez = Math.sign(lz) || 1; prof = penZ; } else { ex = Math.sign(lx) || 1; prof = penX; }
    prof += 1e-4;
    out.set(ex * c + ez * s, 0, -ex * s + ez * c);
    pos.x += out.x * prof; pos.z += out.z * prof;
    return prof;
  }

  // ------------------------------------------------------------ capsula

  /** Empurra a capsula para fora de tudo que a penetra. Retorna quantos contatos houve. */
  _depenetrate(pos, radius, height, normalOut) {
    const halfSeg = Math.max(0.001, height - radius * 2);
    let contatos = 0;
    normalOut.set(0, 0, 0);
    for (let iter = 0; iter < 4; iter++) {
      _seg.start.set(pos.x, pos.y + radius, pos.z);
      _seg.end.set(pos.x, pos.y + radius + halfSeg, pos.z);
      _box.makeEmpty();
      _box.expandByPoint(_seg.start); _box.expandByPoint(_seg.end);
      _box.min.addScalar(-radius); _box.max.addScalar(radius);

      let mexeu = false;
      this.bvh.shapecast({
        intersectsBounds: (bx) => bx.intersectsBox(_box) ? INTERSECTED : NOT_INTERSECTED,
        intersectsTriangle: (tri) => {
          const dist = tri.closestPointToSegment(_seg, _triPt, _capPt);
          if (dist < radius) {
            const depth = radius - dist;
            _push.subVectors(_capPt, _triPt);
            if (_push.lengthSq() < 1e-10) { tri.getNormal(_push); }
            _push.normalize();

            /* Contato de CHAO PISAVEL: resolve so na vertical.
             *
             * Empurrar ao longo da normal parece correto, mas numa ladeira a
             * normal tem componente horizontal apontando morro ABAIXO — subir
             * uma rampa virava um empurrao para tras e o jogador travava em
             * chao aparentemente liso. Levantar na vertical faz a capsula
             * cavalgar a inclinacao, que e o comportamento esperado.
             * O divisor por _push.y compensa a projecao: para sair da
             * penetracao `depth` medida ao longo da normal, o deslocamento
             * vertical equivalente e depth / normal.y. */
            let desloc = depth + 1e-4;
            if (_push.y >= CHAO_PISAVEL_Y) {
              desloc = Math.min(desloc / Math.max(_push.y, 0.25), radius);
              _push.set(0, 1, 0);
            }
            pos.addScaledVector(_push, desloc);
            _seg.start.set(pos.x, pos.y + radius, pos.z);
            _seg.end.set(pos.x, pos.y + radius + halfSeg, pos.z);
            normalOut.add(_push);
            contatos++;
            mexeu = true;
          }
          return false;
        },
      });

      /* Obstaculos moveis (folha de porta) na mesma iteracao do BVH: se
       * resolvessem depois, a folha empurraria o jogador para dentro da parede
       * e o quadro seguinte o devolveria — o classico tremor de canto. */
      const perto = this._perto;
      for (let i = 0; i < perto.length; i++) {
        if (this._empurraDaCaixa(pos, radius, height, perto[i], _push) > 0) {
          normalOut.add(_push);
          contatos++;
          mexeu = true;
        }
      }
      if (!mexeu) break;
    }
    if (contatos > 0) normalOut.normalize();
    return contatos;
  }

  /**
   * Sonda de chao com 5 raios (centro + 4 laterais).
   * Um raio so nao serve: parado na quina de um degrau ou do meio-fio, o raio
   * central pega a FACE VERTICAL do degrau (normal.y = 0) e o personagem
   * "flutua" — era o motivo de nao subir escada.
   * @returns {boolean} achou chao; grava altura/normal/superficie em `res`.
   */
  _sondaChao(pos, radius, alcance, res) {
    const OFF = radius * 0.62;
    const amostras = [[0, 0], [OFF, 0], [-OFF, 0], [0, OFF], [0, -OFF]];
    let melhorY = -Infinity, achou = false;
    for (let i = 0; i < amostras.length; i++) {
      _tmpA.set(pos.x + amostras[i][0], pos.y + radius + 0.02, pos.z + amostras[i][1]);
      _tmpB.set(0, -1, 0);
      const h = this.raycast(_tmpA, _tmpB, radius + alcance);
      if (!h.hit || h.normal.y < 0.5) continue;
      if (h.point.y > melhorY) {
        melhorY = h.point.y;
        res.y = h.point.y;
        res.normal.copy(h.normal);
        res.surface = h.surface;
      }
      achou = true;
    }
    return achou;
  }

  /**
   * Move uma capsula de `start` para `end` com deslizamento em parede e degrau
   * automatico ate `stepHeight`.
   * @param {THREE.Vector3} start posicao dos PES no inicio
   * @param {THREE.Vector3} end   posicao dos PES desejada
   * @param {number} radius raio da capsula
   * @param {number} height altura total da capsula
   */
  capsuleSweep(start, end, radius, height, stepHeight = 0.45) {
    const out = this._cs;
    out.grounded = false; out.hitWall = false; out.stepped = false;
    out.normal.set(0, 1, 0); out.groundNormal.set(0, 1, 0); out.surface = 'concreto';
    if (!this.built) { out.position.copy(end); return out; }

    /* Vizinhanca de obstaculos moveis: recolhida UMA vez por varredura e reusada
     * pelas dezenas de chamadas de `_depenetrate` que vem abaixo. */
    _delta.subVectors(end, start);
    if (this.obstaculos.length) {
      this._coletarObstaculos(start.x, start.z, radius + _delta.length() + stepHeight + 0.5);
    } else this._perto.length = 0;

    const dist = _delta.length();
    // sub-passos menores que o raio: capsula nao atravessa parede fina
    const passos = Math.min(12, Math.max(1, Math.ceil(dist / (radius * 0.5))));
    const incX = _delta.x / passos, incY = _delta.y / passos, incZ = _delta.z / passos;

    /** Marcha de `from` somando o incremento, resolvendo penetracao a cada passo. */
    const marchar = (from, alvoPos, alvoNormal) => {
      _pos.copy(from);
      _normalAcc.set(0, 0, 0);
      let contatos = 0;
      for (let s = 0; s < passos; s++) {
        _pos.x += incX; _pos.y += incY; _pos.z += incZ;
        const n = this._depenetrate(_pos, radius, height, _push);
        if (n > 0) { contatos += n; _normalAcc.add(_push); }
      }
      alvoPos.copy(_pos);
      if (contatos > 0) alvoNormal.copy(_normalAcc).normalize();
      else alvoNormal.set(0, 1, 0);
      return contatos;
    };

    const A = this._resA || (this._resA = { pos: new THREE.Vector3(), normal: new THREE.Vector3() });
    const B = this._resB || (this._resB = { pos: new THREE.Vector3(), normal: new THREE.Vector3() });
    const sonda = this._sonda || (this._sonda = { y: 0, normal: new THREE.Vector3(), surface: 'concreto' });

    const contatosA = marchar(start, A.pos, A.normal);
    let escolhido = A, contatos = contatosA;

    // --- degrau automatico: bloqueou no plano? tenta de novo por cima ---
    const pedidoH = Math.hypot(end.x - start.x, end.z - start.z);
    const obtidoH = Math.hypot(A.pos.x - start.x, A.pos.z - start.z);
    if (stepHeight > 0 && pedidoH > 0.02 && obtidoH < pedidoH * 0.85) {
      _posAlt.set(start.x, start.y + stepHeight, start.z);
      // so tenta se houver espaco livre no ponto elevado
      _tmpA.copy(_posAlt);
      if (this._depenetrate(_tmpA, radius, height, _push) === 0) {
        const contatosB = marchar(_posAlt, B.pos, B.normal);
        const obtidoB = Math.hypot(B.pos.x - start.x, B.pos.z - start.z);
        if (obtidoB > obtidoH + 0.005) {
          // pousa no topo do degrau, nunca acima do limite de subida
          if (this._sondaChao(B.pos, radius, stepHeight + 0.25, sonda)
            && sonda.y <= start.y + stepHeight + 0.02 && sonda.y >= start.y - 0.6) {
            B.pos.y = sonda.y;
            this._depenetrate(B.pos, radius, height, _push);
            escolhido = B; contatos = contatosB;
            out.stepped = true;
          }
        }
      }
    }

    out.position.copy(escolhido.pos);
    out.normal.copy(escolhido.normal);
    out.hitWall = contatos > 0 && Math.abs(escolhido.normal.y) < 0.7;

    /* --- teste de chao (5 raios, imune a quina de degrau) ---
     *
     * So cola no chao quando a capsula NAO esta subindo. Sem esta guarda o pulo
     * nunca sai: a 60 fps a velocidade inicial de 4,65 m/s desloca 7,8 cm por
     * quadro, menos que a tolerancia de 10 cm, entao o snap devolvia o jogador
     * ao chao no mesmo quadro em que ele pulava — e a falha dependia do
     * framerate, aparecendo como "as vezes pula, as vezes nao".
     */
    const subindo = (end.y - start.y) > 1e-4;
    if (!subindo && this._sondaChao(out.position, radius, 0.24, sonda)) {
      const gap = out.position.y - sonda.y;
      if (gap < 0.10) {
        out.grounded = true;
        out.groundNormal.copy(sonda.normal);
        out.surface = sonda.surface;
        out.position.y = sonda.y;                  // cola no chao
      }
    }
    return out;
  }

  dispose() {
    this.geometry?.dispose();
    this.geometry = null;
    this.bvh = null;
    this.faceSurface = null;
    this.obstaculos.length = 0;
    this._perto.length = 0;
    this.built = false;
  }
}

export { SUPERFICIES };
