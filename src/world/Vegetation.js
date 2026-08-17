/**
 * Vegetation — verde tropical de morro carioca: bananeira, palmeira, mangueira,
 * capim alto brotando de toda fresta, trepadeira tomando muro.
 *
 * ## O que mudou e por quê (leia antes de mexer)
 * A versao anterior usava a superficie `grama` — ladrilho de gramado, OPACO, sem
 * canal alfa — e cada folha era so geometria. De longe funcionava; de perto cada
 * cartao virava um quadrilatero verde chapado. Medido no spawn #0: 62 de 72 raios
 * batiam em mato a menos de 8 m, e a `moitaLonge` mais proxima tinha 2,15 m de
 * raio com o olho do jogador a 6 cm do centro dela. Nao era vegetacao, era um muro.
 *
 * Agora:
 *  1. o material e `folha` — atlas 4x4 com ALFA (`generators/folhagem.js`), com
 *     `alphaTest` (recorte binario, barato) em vez de `transparent` (ordenacao,
 *     cara e com artefato de ordem entre folhas do mesmo tufo);
 *  2. cada cartao de folha carrega UV PROPRIA apontando para uma celula do atlas
 *     — u atravessa a largura, v corre da base a ponta. Por isso o batcher recebe
 *     `uv: 'keep'`: a projecao em caixa destruiria esse mapeamento;
 *  3. a `moitaLonge` deixou de ser dois poligonos solidos cruzados e virou moita
 *     de verdade (cartoes de tufo + folhas soltas), com escala de arbusto e nao
 *     de container;
 *  4. as normais sao arredondadas para a cupula da planta depois do build, para a
 *     folhagem acender como volume e nao como um monte de facetas.
 *
 * Dono: WORLD.
 */
import * as THREE from 'three';
import { Rng, clamp, lerp } from './gen/rng.js';
import { chamferCylinder, chamferBox } from './gen/geo.js';
import { mergeLocal } from './Buildings.js';
import { celulaUV, ATLAS_LADO, PRIMEIRO_TUFO } from './materials/generators/folhagem.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _sc = new THREE.Vector3();
const _c = new THREE.Color();

/**
 * ATENÇAO: estas cores sao TINTE por instancia (`instanceColor`), e o batcher
 * zera `material.color` quando ha tinte — ou seja, elas MULTIPLICAM o albedo do
 * atlas de folha, que ja e verde. Antes da existir o atlas o material era um
 * ladrilho cinza-esverdeado e o tinte carregava a cor sozinho (por isso eram
 * verdes escuros tipo #4e6b2e). Multiplicar aquilo pela folha nova daria um
 * verde quase preto — que e exatamente parte do "paredao escuro" reclamado.
 * Agora sao variaçoes proximas do branco, so para nenhuma planta ficar igual a vizinha.
 */
const VERDES = ['#e6f0e0', '#cfe2be', '#eef2e6', '#b6d0a4', '#d9e8c8', '#c4dcb2'];
const VERDES_SECOS = ['#e8e0c2', '#dbd0ad', '#f0ead6'];

const N_CEL = ATLAS_LADO * ATLAS_LADO;

/** Celula de folha inteira (silhueta unica, ponta definida). */
function celFolha(r) { return r.int(0, PRIMEIRO_TUFO - 1); }
/** Celula de TUFO: varios foliolos com vao entre eles, para massa de moita. */
function celTufo(r) { return r.int(PRIMEIRO_TUFO, N_CEL - 1); }

export class Vegetation {
  constructor({ rng, batcher, collision, terrain, favela, props, ancoras, quality }) {
    this.rng = rng;
    this.bat = batcher;
    this.col = collision;
    this.terrain = terrain;
    this.fav = favela;
    this.props = props;
    this.anc = ancoras ?? { lajes: [] };
    this.dens = quality?.vegetationDensity ?? 1;
    this._defProtos();
  }

  _defProtos() {
    const b = this.bat;
    const rp = new Rng(0xbaba7e);

    // `uv: 'keep'` em TODOS: a UV do atlas de folha vem pronta do prototipo.
    const op = (extra = {}) => ({ uv: 'keep', uvScale: 1, side: THREE.DoubleSide, ...extra });

    b.defineInstance('bananeira', () => bananeira(rp, 7), 'folha', op());
    b.defineInstance('bananeira2', () => bananeira(rp, 5), 'folha', op());
    b.defineInstance('palmeira', () => palmeira(rp, 11), 'folha', op());
    b.defineInstance('mangueira', () => mangueira(rp), 'folha', op());
    b.defineInstance('arbusto', () => arbusto(rp, 26, 0.75), 'folha', op());
    b.defineInstance('arbusto2', () => arbusto(rp, 16, 0.5), 'folha', op());
    b.defineInstance('capim', () => capim(rp, 7, 0.75), 'folha', op({ castShadow: false, sectored: true, lodMax: 62 }));
    b.defineInstance('capimBaixo', () => capim(rp, 5, 0.4), 'folha', op({ castShadow: false, sectored: true, lodMax: 52 }));
    b.defineInstance('trepadeira', () => trepadeira(rp), 'folha', op({ castShadow: false, sectored: true, lodMax: 70 }));
    b.defineInstance('moitaLonge', () => moita(rp), 'folha', op({ castShadow: false }));

    // troncos vao no merge estatico (madeira), nao no instanced verde
  }

  construir() {
    this.arvores();
    this.capinzal();
    this.trepadeiras();
    this.vasos();
    this.lajesVerdes();
    this.distante();
  }

  /** Planta dentro dos vasos que o Props espalhou nas portas. */
  vasos() {
    const r = this.rng.fork('vasos');
    for (const v of this.props?.vasos ?? []) {
      _e.set(0, r.range(0, 6.28), 0); _q.setFromEuler(_e);
      const e = v.esc * r.range(0.75, 1.15);
      _sc.set(e, e * r.range(0.9, 1.5), e);
      _m.compose(new THREE.Vector3(v.x, v.y, v.z), _q, _sc);
      _c.set(r.pick(VERDES));
      this.bat.pushInstance(r.chance(0.35) ? 'bananeira2' : 'arbusto2', _m, _c);
    }
  }

  /** Mato e vaso nas lajes — quintal suspenso, marca registrada. */
  lajesVerdes() {
    const r = this.rng.fork('lajeverde');
    for (const laje of this.anc.lajes) {
      if (!r.chance(0.34)) continue;
      const n = r.int(1, 4);
      const c = Math.cos(laje.yaw), s = Math.sin(laje.yaw);
      for (let i = 0; i < n; i++) {
        const lx = r.range(-laje.w * 0.4, laje.w * 0.4), lz = r.range(-laje.d * 0.4, laje.d * 0.4);
        const x = laje.x + lx * c + lz * s, z = laje.z - lx * s + lz * c;
        _e.set(0, r.range(0, 6.28), 0); _q.setFromEuler(_e);
        const e = r.range(0.6, 1.1);
        _sc.set(e, e * r.range(0.8, 1.3), e);
        _m.compose(new THREE.Vector3(x, laje.y + 0.02, z), _q, _sc);
        _c.set(r.pick(VERDES));
        this.bat.pushInstance(r.chance(0.5) ? 'arbusto2' : 'capim', _m, _c);
      }
    }
  }

  /** Posicao valida para planta: fora de via, fora de casa, inclinaçao aceitavel. */
  _livre(x, z, raio) {
    if (Math.abs(x) > 87 || Math.abs(z) > 87) return false;
    if (this.fav.distViaLivre(x, z, raio + 8) < raio) return false;
    return this.fav.livreDeCasa(x, z, raio);
  }

  arvores() {
    const r = this.rng.fork('arvores');
    const alvo = Math.round(460 * clamp(this.dens, 0.3, 1));
    let n = 0;
    for (let tent = 0; tent < alvo * 22 && n < alvo; tent++) {
      const x = r.range(-84, 84), z = r.range(-84, 84);
      const tipo = r.weighted(['bananeira', 'palmeira', 'mangueira', 'arbusto'], [0.30, 0.08, 0.09, 0.53]);
      const raio = tipo === 'mangueira' ? 2.4 : tipo === 'palmeira' ? 0.9 : tipo === 'bananeira' ? 0.9 : 0.55;
      if (!this._livre(x, z, raio)) continue;
      const y = this.terrain.heightAt(x, z);
      const esc = r.range(0.78, 1.28);
      _e.set(r.range(-0.06, 0.06), r.range(0, 6.28), r.range(-0.06, 0.06));
      _q.setFromEuler(_e);
      _sc.set(esc, esc * r.range(0.9, 1.15), esc);
      _m.compose(new THREE.Vector3(x, y, z), _q, _sc);
      _c.set(r.pick(VERDES));
      const nome = tipo === 'bananeira' ? (r.chance(0.5) ? 'bananeira' : 'bananeira2')
        : tipo === 'arbusto' ? (r.chance(0.5) ? 'arbusto' : 'arbusto2') : tipo;
      this.bat.pushInstance(nome, _m, _c);

      // tronco solido no merge + colisao para arvores grandes
      if (tipo === 'palmeira' || tipo === 'mangueira') {
        const alt = (tipo === 'palmeira' ? 6.2 : 3.4) * esc;
        const rr = (tipo === 'palmeira' ? 0.14 : 0.26) * esc;
        const g = chamferCylinder(rr * 0.8, rr, alt, 7, 0.02);
        _m.makeRotationY(r.range(0, 6.28));
        _m.setPosition(x, y + alt * 0.5, z);
        this.bat.add(g, _m, 'madeira', { uvScale: 0.8 });
        this.col.addBox(x, y + alt * 0.5, z, rr * 2, alt, rr * 2, 0, 'madeira');
      } else if (tipo === 'bananeira') {
        const alt = 2.1 * esc;
        const g = chamferCylinder(0.09 * esc, 0.14 * esc, alt, 6, 0.02);
        _m.makeRotationY(r.range(0, 6.28));
        _m.setPosition(x, y + alt * 0.5, z);
        this.bat.add(g, _m, 'madeira', { uvScale: 0.6 });
      }
      n++;
    }
    this.statsArvores = n;
  }

  /** Capim alto: beira de beco, pe de muro, degrau rachado, terreno baldio. */
  capinzal() {
    const r = this.rng.fork('capim');
    const alvo = Math.round(4200 * clamp(this.dens, 0.25, 1));
    let n = 0;

    // 1) na borda de fora do calçamento — o capim que nasce da rachadura.
    //    Fica LOGO APOS a largura da via para o tufo nao afundar no piso.
    for (const via of this.fav.vias) {
      const foraDaVia = via.tipo === 'rua' ? 2.1 : 0.06;
      for (let i = 1; i < via.pts.length - 1; i++) {
        if (!r.chance(via.escada[i] ? 0.8 : 0.5)) continue;
        const p = via.pts[i], pn = via.pts[i + 1];
        let dx = pn[0] - p[0], dz = pn[1] - p[1];
        const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
        const lado = r.sign();
        const off = via.w * 0.5 + foraDaVia + r.range(-0.06, 0.28);
        const x = p[0] - dz * lado * off, z = p[1] + dx * lado * off;
        const y = this.terrain.heightAt(x, z);
        this._tufo(x, y, z, r, via.escada[i] ? 0.7 : 1.0);
        n++;
      }
    }
    // 2) pe de muro
    for (const mu of this.fav.muros) {
      if (!r.chance(0.5)) continue;
      const k = r.int(1, 4);
      for (let i = 0; i < k; i++) {
        const t = r.range(-0.45, 0.45);
        const x = mu.x + Math.cos(mu.yaw) * t * mu.len - Math.sin(mu.yaw) * r.range(0.14, 0.3);
        const z = mu.z - Math.sin(mu.yaw) * t * mu.len - Math.cos(mu.yaw) * r.range(0.14, 0.3);
        this._tufo(x, this.terrain.heightAt(x, z), z, r, 0.9);
        n++;
      }
    }
    // 3) terreno baldio
    for (let tent = 0; tent < alvo * 5 && n < alvo; tent++) {
      const x = r.range(-88, 88), z = r.range(-88, 88);
      if (!this._livre(x, z, 0.28)) continue;
      const incl = this.terrain.slopeAt(x, z);
      if (incl < 0.14 && r.chance(0.45)) continue;   // capim gosta de barranco
      this._tufo(x, this.terrain.heightAt(x, z), z, r, 1.15);
      n++;
    }
    this.statsCapim = n;
  }

  _tufo(x, y, z, r, escBase) {
    _e.set(r.range(-0.12, 0.12), r.range(0, 6.28), r.range(-0.12, 0.12));
    _q.setFromEuler(_e);
    const e = escBase * r.range(0.7, 1.35);
    _sc.set(e, e * r.range(0.8, 1.3), e);
    _m.compose(new THREE.Vector3(x, y - 0.03, z), _q, _sc);
    _c.set(r.chance(0.22) ? r.pick(VERDES_SECOS) : r.pick(VERDES));
    this.bat.pushInstance(r.chance(0.55) ? 'capim' : 'capimBaixo', _m, _c);
  }

  /** Trepadeira tomando muro e parede de fundo. */
  trepadeiras() {
    const r = this.rng.fork('trepadeira');
    for (const mu of this.fav.muros) {
      if (!r.chance(0.26)) continue;
      const lado = r.sign();
      const nx = -Math.sin(mu.yaw) * lado, nz = -Math.cos(mu.yaw) * lado;
      const k = Math.max(1, Math.round(mu.len / 1.5));
      for (let i = 0; i < k; i++) {
        const t = (i + 0.5) / k - 0.5;
        const x = mu.x + Math.cos(mu.yaw) * t * mu.len + nx * 0.14;
        const z = mu.z - Math.sin(mu.yaw) * t * mu.len + nz * 0.14;
        _e.set(0, Math.atan2(nx, nz), 0); _q.setFromEuler(_e);
        const e = r.range(0.8, 1.3);
        _sc.set(e, Math.min(mu.h / 1.6, 1.5) * r.range(0.7, 1.1), e);
        _m.compose(new THREE.Vector3(x, mu.y + mu.h * 0.45, z), _q, _sc);
        _c.set(r.pick(VERDES));
        this.bat.pushInstance('trepadeira', _m, _c);
      }
    }
  }

  /**
   * Moitas espalhadas: a massa verde que fecha o horizonte no anel de borda e
   * quebra o terreno baldio no miolo.
   *
   * ESCALA E O PONTO CRITICO AQUI. A versao antiga sorteava 1,1 a 2,6 e o
   * prototipo tinha 0,55 de raio: dava moita de 2,8 m de largura e 4,4 m de
   * altura — na pratica um tapume. O jogador nascia dentro de uma. Agora o
   * sorteio respeita o tamanho de arbusto (raio de mundo <= 0,9 m) e o teste de
   * espaco livre usa o raio REAL, nao um numero fixo.
   */
  distante() {
    const r = this.rng.fork('longe');
    const alvo = Math.round(420 * clamp(this.dens, 0.3, 1));
    let n = 0;
    for (let tent = 0; tent < alvo * 8 && n < alvo; tent++) {
      const x = r.range(-89, 89), z = r.range(-89, 89);
      const borda = Math.max(Math.abs(x), Math.abs(z));
      const noMiolo = borda < 62;
      if (noMiolo && !r.chance(0.12)) continue;
      // No miolo (onde se joga) a moita nasce menor; na borda pode encorpar.
      const e = noMiolo ? r.range(0.70, 1.15) : r.range(0.85, 1.55);
      const raioReal = RAIO_MOITA * e + 0.15;
      if (!this._livre(x, z, raioReal)) continue;
      const y = this.terrain.heightAt(x, z);
      _e.set(0, r.range(0, 6.28), 0); _q.setFromEuler(_e);
      _sc.set(e, e * r.range(0.8, 1.25), e);
      _m.compose(new THREE.Vector3(x, y, z), _q, _sc);
      _c.set(r.chance(0.18) ? r.pick(VERDES_SECOS) : r.pick(VERDES));
      this.bat.pushInstance('moitaLonge', _m, _c);
      n++;
    }
    this.statsMoitas = n;
  }
}

// ---------------------------------------------------------------- construtor

/**
 * Construtor de folhagem: igual ao TriBuilder, mas carrega UV por vertice.
 *
 * Existe separado porque o `TriBuilder` de `gen/geo.js` e compartilhado com
 * Buildings/Props e nao tem canal de UV — e porque o `tri()` dele pode inverter
 * o winding, o que embaralharia a UV se ela fosse anexada por fora.
 */
class MatoBuilder {
  constructor() { this.pos = []; this.nrm = []; this.uv = []; }

  get triangleCount() { return this.pos.length / 9; }

  /** Triangulo com UV por vertice. `n` null = usa a normal da face. */
  tri(a, b, c, n, ua, ub, uc) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const len = Math.hypot(cx, cy, cz);
    if (len < 1e-12) return;                       // degenerado, descarta
    cx /= len; cy /= len; cz /= len;
    let nx = n ? n[0] : cx, ny = n ? n[1] : cy, nz = n ? n[2] : cz;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const flip = (cx * nx + cy * ny + cz * nz) < 0;
    const p = this.pos, q = this.nrm, t = this.uv;
    if (flip) {
      p.push(a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2]);
      t.push(ua[0], ua[1], uc[0], uc[1], ub[0], ub[1]);
    } else {
      p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      t.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
    }
    for (let i = 0; i < 3; i++) q.push(nx, ny, nz);
  }

  quad(a, b, c, d, n, ua, ub, uc, ud) {
    this.tri(a, b, c, n, ua, ub, uc);
    this.tri(a, c, d, n, ua, uc, ud);
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    return g;
  }
}

/**
 * Arredonda as normais na direçao da cupula da planta.
 *
 * Sem isto, cada cartao de folha acende com a normal da propria face: metade da
 * copa fica preta, metade estourada, e o olho le "monte de placas". Puxando a
 * normal para (vertice - centro) a copa acende como um volume so — e o truque
 * padrao de folhagem em jogo, e nao custa nada em tempo de execuçao.
 *
 * @param {number} peso 0 = so a face, 1 = so a cupula.
 */
function arredondarNormais(geo, centro, peso) {
  const p = geo.attributes.position.array;
  const nrm = geo.attributes.normal.array;
  for (let i = 0; i < p.length; i += 3) {
    let dx = p[i] - centro[0], dy = p[i + 1] - centro[1], dz = p[i + 2] - centro[2];
    const dl = Math.hypot(dx, dy, dz);
    if (dl < 1e-5) continue;
    dx /= dl; dy /= dl; dz /= dl;
    // A normal da face tem dois sentidos possiveis (o material e DoubleSide);
    // alinhamos com a cupula antes de misturar para nao cancelar.
    const s = (nrm[i] * dx + nrm[i + 1] * dy + nrm[i + 2] * dz) < 0 ? -1 : 1;
    let nx = lerp(nrm[i] * s, dx, peso);
    let ny = lerp(nrm[i + 1] * s, dy, peso);
    let nz = lerp(nrm[i + 2] * s, dz, peso);
    const l = Math.hypot(nx, ny, nz) || 1;
    nrm[i] = nx / l; nrm[i + 1] = ny / l; nrm[i + 2] = nz / l;
  }
  return geo;
}

// ---------------------------------------------------------------- prototipos

/**
 * Folha: laminado curvo mapeado numa celula do atlas de folha.
 *
 * A geometria da a curva, a dobra e a inclinaçao; o ALFA da a silhueta (ponta,
 * serrilha, rasgo, furo de inseto). Por isso o perfil geometrico nao vai mais a
 * zero nas pontas (`0.24 + 0.76*sin`): se fosse, a ponta seria afinada duas
 * vezes — uma pela malha e outra pela textura — e a folha viraria agulha.
 *
 * O cartao usa SEMPRE a celula inteira em u. Recortar uma faixa central da
 * celula (para uma lamina estreita, por exemplo) parece tentador mas trunca a
 * folha: a silhueta do atlas afina perto da base e da ponta, e uma faixa
 * estreita deixa de intersecta-la ali — a lamina sumiria antes de chegar na
 * ponta. Cartao estreito resolve-se com geometria estreita, nao com UV estreita.
 *
 * @param {number} cel indice de celula no atlas (ver folhagem.js)
 */
function folhaCard(b, base, ponta, largura, curva = 0.12, segs = 4, cel = 0) {
  const dir = ponta.clone().sub(base);
  const comp = dir.length();
  if (comp < 1e-5) return;
  dir.normalize();
  const up = Math.abs(dir.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const lado = new THREE.Vector3().crossVectors(dir, up).normalize();
  const dobra = new THREE.Vector3().crossVectors(lado, dir).normalize();
  const [u0, v0, du, dv] = celulaUV(cel);

  const pt = (t, s) => {
    // PERFIL — mexer aqui custa caro, leia antes:
    // o `^0.45` engorda o meio do cartao (a folha do atlas e cheia ali, e um
    // cartao magro cortaria a folha) mas o seno CONTINUA indo a zero em t=0 e
    // t=1. Isso importa por dois motivos: os quads das pontas ficam degenerados
    // e o TriBuilder os descarta (~30% dos triangulos da vegetaçao), e o cartao
    // deixa de ter faixa transparente sobrando, que em alphaTest custa
    // amostragem de textura por fragmento so para descartar. Um perfil do tipo
    // `0.24 + 0.76*sin` (sem zero nas pontas) foi medido: +100% de ms/quadro.
    const perfil = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.68)), 0.45) * largura * 0.5;
    const sag = -curva * comp * t * t;
    const p = base.clone().addScaledVector(dir, comp * t)
      .addScaledVector(lado, s * perfil)
      .addScaledVector(dobra, sag + Math.abs(s) * perfil * 0.18);
    return [p.x, p.y, p.z];
  };
  const uv = (t, s) => [u0 + (0.5 + s * 0.5) * du, v0 + t * dv];

  for (let i = 0; i < segs; i++) {
    const t0 = i / segs, t1 = (i + 1) / segs;
    b.quad(pt(t0, -1), pt(t1, -1), pt(t1, 0), pt(t0, 0), null,
      uv(t0, -1), uv(t1, -1), uv(t1, 0), uv(t0, 0));
    b.quad(pt(t0, 0), pt(t1, 0), pt(t1, 1), pt(t0, 1), null,
      uv(t0, 0), uv(t1, 0), uv(t1, 1), uv(t0, 1));
  }
}

/**
 * Cartao de tufo: um retangulo levemente arqueado mapeado numa celula de TUFO.
 * O alfa recorta 5 a 7 foliolos com vao entre eles — massa verde legivel por
 * 8 triangulos. E o que segura a silhueta da moita a 80 m.
 *
 * `larg` e a largura TOTAL do cartao; `alt` sobe de `cy` para cima.
 */
function cartaoTufo(b, cx, cy, cz, larg, alt, ang, cel, arqueio = 0.14) {
  const [u0, v0, du, dv] = celulaUV(cel);
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const nx = -sa, nz = ca;
  const cols = 2, rows = 2;
  const P = (i, j) => {
    const fx = (i / cols - 0.5), fy = j / rows;
    // arqueio: as pontas laterais vem para a frente, tirando o ar de placa
    const off = arqueio * larg * (fx * fx * 4 - 1) * 0.5;
    return [
      cx + ca * fx * larg + nx * off,
      cy + fy * alt,
      cz + sa * fx * larg + nz * off,
    ];
  };
  const U = (i, j) => [u0 + (i / cols) * du, v0 + (j / rows) * dv];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      b.quad(P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1), null,
        U(i, j), U(i + 1, j), U(i + 1, j + 1), U(i, j + 1));
    }
  }
}

function bananeira(r, nFolhas) {
  const b = new MatoBuilder();
  const alt = 2.0;
  for (let i = 0; i < nFolhas; i++) {
    const a = (i / nFolhas) * Math.PI * 2 + r.range(-0.3, 0.3);
    const inc = r.range(0.55, 1.25);
    const comp = r.range(1.5, 2.4);
    const base = new THREE.Vector3(0, alt - r.range(0, 0.35), 0);
    const ponta = new THREE.Vector3(
      Math.cos(a) * comp * Math.cos(inc * 0.9),
      alt + comp * Math.sin(1.35 - inc),
      Math.sin(a) * comp * Math.cos(inc * 0.9),
    );
    // folha de bananeira e larga e rasgada: celula inteira, sem estreitar a UV
    folhaCard(b, base, ponta, r.range(0.42, 0.62), r.range(0.16, 0.3), 5, celFolha(r));
  }
  // cacho
  if (r.chance(0.4)) {
    for (let i = 0; i < 3; i++) {
      const g = new THREE.Vector3(r.range(-0.15, 0.15), alt - 0.4 - i * 0.13, r.range(-0.15, 0.15));
      folhaCard(b, g, g.clone().add(new THREE.Vector3(0.2, -0.18, 0.05)), 0.16, 0.05, 2, celFolha(r));
    }
  }
  return arredondarNormais(b.build(), [0, alt + 0.5, 0], 0.55);
}

function palmeira(r, nFolhas) {
  const b = new MatoBuilder();
  const alt = 6.1;
  for (let i = 0; i < nFolhas; i++) {
    const a = (i / nFolhas) * Math.PI * 2 + r.range(-0.2, 0.2);
    const comp = r.range(2.0, 3.0);
    const queda = r.range(0.3, 1.1);
    const base = new THREE.Vector3(0, alt, 0);
    const ponta = new THREE.Vector3(Math.cos(a) * comp, alt + comp * (0.75 - queda), Math.sin(a) * comp);
    // folha pinada: um raque com foliolos
    const dir = ponta.clone().sub(base);
    const nF = 9;
    const celR = celFolha(r);
    for (let k = 1; k <= nF; k++) {
      const t = k / nF;
      const p = base.clone().addScaledVector(dir, t).add(new THREE.Vector3(0, -0.35 * t * t * comp * 0.35, 0));
      const perp = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
      for (const s of [-1, 1]) {
        const fim = p.clone().addScaledVector(perp, s * 0.36 * (1 - t * 0.5)).add(new THREE.Vector3(0, -0.22, 0));
        // foliolo e uma fita estreita: so a faixa central da celula
        folhaCard(b, p, fim, 0.11, 0.05, 2, celFolha(r));
      }
    }
    folhaCard(b, base, ponta, 0.1, 0.1, 4, celR);
  }
  return arredondarNormais(b.build(), [0, alt - 0.4, 0], 0.5);
}

function mangueira(r) {
  const b = new MatoBuilder();
  const troncoAlt = 3.2;
  // galhos
  const galhos = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + r.range(-0.4, 0.4);
    const comp = r.range(1.6, 2.6);
    const alvo = new THREE.Vector3(Math.cos(a) * comp, troncoAlt + r.range(0.6, 1.8), Math.sin(a) * comp);
    galhos.push(alvo);
    const base = new THREE.Vector3(0, troncoAlt - 0.4, 0);
    folhaCard(b, base, alvo, 0.13, 0.02, 2, celFolha(r));
  }
  // copa: aglomerados de folhas pequenas + cartoes de tufo para dar massa
  for (const g of galhos) {
    const nC = 9;
    for (let k = 0; k < nC; k++) {
      const c = g.clone().add(new THREE.Vector3(r.range(-1.3, 1.3), r.range(-0.8, 1.4), r.range(-1.3, 1.3)));
      const nL = 5;
      for (let l = 0; l < nL; l++) {
        const a = r.range(0, 6.28), inc = r.range(-0.9, 0.5);
        const comp = r.range(0.24, 0.42);
        const fim = c.clone().add(new THREE.Vector3(
          Math.cos(a) * comp, Math.sin(inc) * comp, Math.sin(a) * comp));
        folhaCard(b, c, fim, r.range(0.09, 0.15), 0.05, 2, celFolha(r));
      }
    }
    // dois cartoes cruzados por galho: e o que a copa mostra a 40 m
    for (let k = 0; k < 2; k++) {
      cartaoTufo(b, g.x, g.y - 0.7, g.z, 1.15, 1.7, k * 1.57 + r.range(-0.3, 0.3), celTufo(r), 0.2);
    }
  }
  return arredondarNormais(b.build(), [0, troncoAlt + 0.6, 0], 0.6);
}

function arbusto(r, nFolhas, alt) {
  const b = new MatoBuilder();
  for (let i = 0; i < nFolhas; i++) {
    const a = r.range(0, 6.28);
    const rad = r.range(0.05, 0.42);
    const base = new THREE.Vector3(Math.cos(a) * rad * 0.4, r.range(0, alt * 0.5), Math.sin(a) * rad * 0.4);
    const comp = r.range(0.3, 0.62) * (alt / 0.75);
    const inc = r.range(0.1, 1.2);
    const fim = base.clone().add(new THREE.Vector3(
      Math.cos(a) * comp * Math.cos(inc), comp * Math.sin(inc), Math.sin(a) * comp * Math.cos(inc)));
    folhaCard(b, base, fim, r.range(0.14, 0.26), 0.14, 3, celFolha(r));
  }
  return arredondarNormais(b.build(), [0, alt * 0.45, 0], 0.6);
}

function capim(r, nLaminas, alt) {
  const b = new MatoBuilder();
  for (let i = 0; i < nLaminas; i++) {
    const a = (i / nLaminas) * 6.28 + r.range(-0.4, 0.4);
    const rad = r.range(0, 0.09);
    const base = new THREE.Vector3(Math.cos(a) * rad, 0, Math.sin(a) * rad);
    const h = alt * r.range(0.6, 1.25);
    const tomb = r.range(0.1, 0.5);
    const fim = base.clone().add(new THREE.Vector3(Math.cos(a) * h * tomb, h, Math.sin(a) * h * tomb));
    // lamina de capim: faixa estreita da celula, a UV corre da base a ponta
    folhaCard(b, base, fim, r.range(0.05, 0.09), 0.28, 3, celFolha(r));
  }
  return arredondarNormais(b.build(), [0, alt * 0.3, 0], 0.4);
}

function trepadeira(r) {
  const b = new MatoBuilder();
  for (let i = 0; i < 22; i++) {
    const x = r.range(-0.55, 0.55), y = r.range(-0.8, 0.8);
    const base = new THREE.Vector3(x, y, 0);
    const a = r.range(0, 6.28);
    const comp = r.range(0.12, 0.26);
    const fim = base.clone().add(new THREE.Vector3(Math.cos(a) * comp, Math.sin(a) * comp, r.range(0.02, 0.12)));
    folhaCard(b, base, fim, r.range(0.1, 0.18), 0.05, 2, celFolha(r));
  }
  // gavinhas descendo
  for (let i = 0; i < 4; i++) {
    const x = r.range(-0.5, 0.5);
    folhaCard(b, new THREE.Vector3(x, 0.7, 0.03), new THREE.Vector3(x + r.range(-0.1, 0.1), -0.9, 0.05),
      0.045, 0, 3, celFolha(r));
  }
  return arredondarNormais(b.build(), [0, 0, -0.25], 0.5);
}

/** Raio horizontal do prototipo de moita, em metros (escala 1). */
const RAIO_MOITA = 0.58;

/**
 * Moita: o que era "dois cartoes cruzados com silhueta recortada" e na pratica
 * dois POLIGONOS SOLIDOS de 2,8 m — o paredao que motivou esta correçao.
 *
 * Agora sao tres cartoes de TUFO (o alfa recorta os foliolos e abre vao) mais um
 * punhado de folhas soltas para o volume de perto. Mesma ordem de grandeza de
 * triangulos, silhueta de planta em qualquer distancia, e da para ver atraves.
 */
function moita(r) {
  const b = new MatoBuilder();
  const altura = 1.15;

  // 1) massa: tres cartoes cruzados, cada um com sua celula de tufo
  const n = 3;
  for (let k = 0; k < n; k++) {
    const ang = (k / n) * Math.PI + r.range(-0.18, 0.18);
    cartaoTufo(b, 0, 0, 0, RAIO_MOITA * 2 * r.range(0.88, 1.06), altura * r.range(0.85, 1.15),
      ang, celTufo(r), 0.18);
  }
  // 2) um cartao mais baixo e mais largo: o pe da moita, que fecha o rodape
  cartaoTufo(b, 0, -0.04, 0, RAIO_MOITA * 2.2, altura * 0.52, r.range(0, 3.14), celTufo(r), 0.26);

  // 3) folhas soltas na periferia: quebram a leitura de cartao quando se chega perto
  for (let i = 0; i < 9; i++) {
    const a = r.range(0, 6.28);
    const rad = r.range(0.1, RAIO_MOITA * 0.8);
    const base = new THREE.Vector3(Math.cos(a) * rad, r.range(0.05, altura * 0.7), Math.sin(a) * rad);
    const comp = r.range(0.22, 0.42);
    const inc = r.range(-0.1, 1.0);
    const fim = base.clone().add(new THREE.Vector3(
      Math.cos(a) * comp * Math.cos(inc), comp * Math.sin(inc), Math.sin(a) * comp * Math.cos(inc)));
    folhaCard(b, base, fim, r.range(0.14, 0.24), 0.12, 2, celFolha(r));
  }
  return arredondarNormais(b.build(), [0, altura * 0.42, 0], 0.62);
}

export { mergeLocal, chamferBox };
