/**
 * Buildings — casas de alvenaria da favela.
 *
 * Regras de composicao que fazem a leitura "favela" e nao "predio generico":
 *  - cada andar e uma obra diferente: material, pe-direito e recuo proprios;
 *  - a laje sempre sobra alem da parede (beiral) e serve de terraco do vizinho;
 *  - ferro de espera saindo do topo — a casa nunca esta pronta;
 *  - nada em prumo perfeito: as paredes tem taper e tilt de 0,3 a 1 grau;
 *  - quinas chanfradas em 2,5 cm.
 *
 * Nao cria props: publica ancoras (lajes, janelas, beirais) que Props consome.
 * Dono: WORLD.
 */
import * as THREE from 'three';
import { Rng, clamp, lerp } from './gen/rng.js';
import { chamferBox, simpleBox, corrugatedSheet, plane, TriBuilder } from './gen/geo.js';
import { surfaceOf } from './gen/materials.js';

const _m = new THREE.Matrix4();
const _mHouse = new THREE.Matrix4();
const _v = new THREE.Vector3();

export class Buildings {
  constructor({ rng, batcher, collision, terrain }) {
    this.rng = rng;
    this.bat = batcher;
    this.col = collision;
    this.terrain = terrain;
    // ancoras publicadas para Props/Vegetation
    this.ancoras = {
      lajes: [],      // {x,y,z,w,d,yaw, casa}
      janelas: [],    // {x,y,z, nx,nz, w,h, andar, casa}
      beirais: [],    // {x,y,z, nx,nz} pontos altos bons para fio/varal
      telhados: [],   // {x,y,z,w,d,yaw,inc,dir} telha de fibrocimento (recebe tijolo/pneu)
      fachadas: [],   // {x,y,z, nx,nz, w,h} paredes de rua (pichaçao)
      portas: [],     // {x,y,z, nx,nz}
    };
    this._defInstancias();
  }

  _defInstancias() {
    const b = this.bat;
    // grade de ferro de janela: 5 barras verticais + 2 horizontais.
    // Barra de 18 mm nao ganha nada com chanfro — simpleBox (12 tris) e o certo.
    b.defineInstance('grade', () => {
      const parts = [];
      for (let i = 0; i < 5; i++) {
        const geo = simpleBox(0.018, 1, 0.018);
        geo.translate((i / 4 - 0.5) * 0.9, 0, 0);
        parts.push(geo);
      }
      for (let j = 0; j < 2; j++) {
        const geo = simpleBox(1.0, 0.02, 0.018);
        geo.translate(0, (j - 0.5) * 0.66, 0);
        parts.push(geo);
      }
      return mergeLocal(parts);
    }, 'metal_pintado', { uvScale: 0.5, sectored: true, lodMax: 90 });

    // moldura simples de janela (batente)
    b.defineInstance('vidro', () => plane(1, 1, 1, 1), 'vidro', { uvScale: 1, castShadow: false, transparent: true, opacity: 0.42, side: THREE.DoubleSide });

    // ar-condicionado de janela
    b.defineInstance('arcond', () => {
      const parts = [chamferBox(0.62, 0.42, 0.5, 0.02)];
      const gr = chamferBox(0.5, 0.3, 0.03, 0.006); gr.translate(0, 0, 0.26); parts.push(gr);
      return mergeLocal(parts);
    }, 'metal_pintado', { uvScale: 0.4 });

    // ferro de espera (vergalhao) saindo da laje
    b.defineInstance('vergalhao', () => simpleBox(0.016, 1, 0.016), 'metal_ondulado',
      { uvScale: 0.3, sectored: true, lodMax: 60 });

    // tijolo solto (segura telha)
    b.defineInstance('tijoloSolto', () => chamferBox(0.19, 0.09, 0.09, 0.008), 'tijolo',
      { uvScale: 0.5, sectored: true, lodMax: 80 });

    // pneu careca (segura telha)
    b.defineInstance('pneu', () => {
      const g = new THREE.TorusGeometry(0.28, 0.09, 5, 8);
      g.rotateX(Math.PI / 2);
      return g.toNonIndexed();
    }, 'borracha', { uv: 'keep', uvScale: 1.2 });

    // caixa de luz / relogio na fachada
    b.defineInstance('relogioLuz', () => {
      const parts = [chamferBox(0.3, 0.4, 0.14, 0.012)];
      const v = chamferBox(0.16, 0.12, 0.02, 0.004); v.translate(0, 0.06, 0.08); parts.push(v);
      return mergeLocal(parts);
    }, 'plastico', { uvScale: 0.35 });
  }

  /** Constroi todas as casas do plano. */
  construir(casas) {
    for (const casa of casas) {
      const r = new Rng(casa.seed ?? 1);
      _mHouse.makeRotationY(casa.yaw);
      _mHouse.setPosition(casa.x, casa.baseY, casa.z);
      if (casa.tunel) this._casaTunel(casa, r);
      else this._casaNormal(casa, r);
    }
  }

  // ------------------------------------------------------------- casa comum

  _casaNormal(casa, r) {
    if (casa.pilotis) this._pilotis(casa, r);

    for (let a = 0; a < casa.andares.length; a++) {
      const an = casa.andares[a];
      const w = an.w, d = an.d;
      const y0 = an.y0, h = an.h;
      const esp = a === 0 ? 0.235 : r.range(0.15, 0.21);
      const cx = an.desloc[0], cz = an.desloc[1];

      const aberturasPorParede = this._planejarAberturas(casa, a, w, d, r);
      // giro proprio do andar: obra de epoca diferente raramente sai no esquadro
      const ya = an.yaw || 0;
      const ca = Math.cos(ya), sa = Math.sin(ya);
      const R = (px, pz) => {
        const ux = px - cx, uz = pz - cz;
        return [cx + ux * ca + uz * sa, cz - ux * sa + uz * ca];
      };
      const RN = (nx, nz) => [nx * ca + nz * sa, -nx * sa + nz * ca];
      const paredes = [
        { A: R(cx - w / 2, cz - d / 2), B: R(cx + w / 2, cz - d / 2), n: RN(0, -1), comp: w, key: 'z-' },
        { A: R(cx + w / 2, cz + d / 2), B: R(cx - w / 2, cz + d / 2), n: RN(0, 1), comp: w, key: 'z+' },
        { A: R(cx - w / 2, cz + d / 2), B: R(cx - w / 2, cz - d / 2), n: RN(-1, 0), comp: d, key: 'x-' },
        { A: R(cx + w / 2, cz - d / 2), B: R(cx + w / 2, cz + d / 2), n: RN(1, 0), comp: d, key: 'x+' },
      ];
      for (const p of paredes) { p.nx = p.n[0]; p.nz = p.n[1]; }

      for (const p of paredes) {
        this._parede(casa, {
          A: p.A, B: p.B, y0, h, esp, mat: an.mat,
          aberturas: aberturasPorParede[p.key] || [],
          nx: p.nx, nz: p.nz, andar: a, r,
        });
      }

      // colisao: bloco solido por andar (o interior nao e jogavel)
      if (!casa.interior || a > 0) {
        this._colBox(casa, cx, y0 + h * 0.5, cz, w, h, d, surfaceOf(an.mat), ya);
      } else {
        for (const p of paredes) this._colParede(casa, p, y0, h, esp, an.mat);
        this._colBox(casa, cx, y0 + 0.06, cz, w, h * 0.1, d, 'concreto', ya);
      }

      // miolo escuro: impede enxergar de um lado a outro pelas janelas
      if (!casa.interior || a > 0) {
        const g = chamferBox(Math.max(0.5, w - esp * 2 - 0.06), h - 0.08, Math.max(0.5, d - esp * 2 - 0.06), 0.02);
        this.bat.add(g, this._mat(casa, cx, y0 + h * 0.5, cz, ya), 'borracha', { uvScale: 2 });
      }

      // laje entre andares (com beiral)
      const salto = an.lajeSalto;
      const espLaje = r.range(0.17, 0.24);
      const lw = w + salto * 2, ld = d + salto * 2;
      const glaje = chamferBox(lw, espLaje, ld, 0.03, { taper: r.range(0, 0.01) });
      this.bat.add(glaje, this._mat(casa, cx, y0 + h + espLaje * 0.5, cz, ya), 'concreto', { uvScale: 1 });
      this._colBox(casa, cx, y0 + h + espLaje * 0.5, cz, lw, espLaje, ld, 'concreto', ya);

      // marquise de telha sobre a fachada da frente (protege a porta da chuva)
      if (a === 0 && r.chance(0.3)) {
        const lz = casa.frenteZ * (d * 0.5 + 0.42);
        const gm = corrugatedSheet(w * 0.85, 1.0, 0.022, 0.16, 0.03);
        gm.rotateX(casa.frenteZ * 0.2);
        this.bat.add(gm, this._mat(casa, cx, y0 + h - 0.28, cz + lz, ya),
          r.chance(0.5) ? 'telha_fibrocimento' : 'metal_ondulado', { uvScale: 1 });
      }

      // ancoras de beiral (fio, varal, trepadeira)
      this.ancoras.beirais.push(this._pt(casa, cx + w * 0.5 * 0.9, y0 + h + espLaje, cz));
      if (r.chance(0.5)) this.ancoras.beirais.push(this._pt(casa, cx - w * 0.5 * 0.9, y0 + h + espLaje, cz));
    }

    this._topo(casa, r);
    if (casa.escadaExterna) this._escadaExterna(casa, r);
  }

  /** Casa que atravessa o beco: terreo aberto, andares por cima. */
  _casaTunel(casa, r) {
    const an0 = casa.andares[0];
    const hVao = casa.tunelAltura;
    const vao = casa.tunelVao;
    const w = casa.w, d = casa.d;
    const lateral = Math.max(0.9, (d - vao) * 0.5);

    // dois blocos laterais no terreo, com pilar de concreto na aresta do vao
    for (const s of [-1, 1]) {
      const zc = s * (vao * 0.5 + lateral * 0.5);
      const g = chamferBox(w, hVao, lateral, 0.03, { taper: 0.006 });
      this.bat.add(g, this._mat(casa, 0, hVao * 0.5, zc, 0), an0.mat, { uvScale: 1 });
      this._colBox(casa, 0, hVao * 0.5, zc, w, hVao, lateral, surfaceOf(an0.mat));
      // pilar aparente
      for (const sx of [-1, 1]) {
        const gp = chamferBox(0.26, hVao, 0.26, 0.02);
        this.bat.add(gp, this._mat(casa, sx * (w * 0.5 - 0.16), hVao * 0.5, s * (vao * 0.5 - 0.13), 0), 'concreto', { uvScale: 1 });
      }
    }
    // laje do tunel
    const espL = 0.22;
    const gl = chamferBox(w + 0.3, espL, d + 0.3, 0.03);
    this.bat.add(gl, this._mat(casa, 0, hVao + espL * 0.5, 0, 0), 'concreto', { uvScale: 1 });
    this._colBox(casa, 0, hVao + espL * 0.5, 0, w + 0.3, espL, d + 0.3, 'concreto');

    // andares acima
    for (let a = 1; a < casa.andares.length; a++) {
      const an = casa.andares[a];
      const y0 = hVao + espL + (an.y0 - casa.andares[1].y0);
      const aw = an.w, ad = an.d;
      const paredes = [
        { A: [-aw / 2, -ad / 2], B: [aw / 2, -ad / 2], nx: 0, nz: -1, key: 'z-' },
        { A: [aw / 2, ad / 2], B: [-aw / 2, ad / 2], nx: 0, nz: 1, key: 'z+' },
        { A: [-aw / 2, ad / 2], B: [-aw / 2, -ad / 2], nx: -1, nz: 0, key: 'x-' },
        { A: [aw / 2, -ad / 2], B: [aw / 2, ad / 2], nx: 1, nz: 0, key: 'x+' },
      ];
      const ab = this._planejarAberturas(casa, a, aw, ad, r);
      for (const p of paredes) {
        this._parede(casa, { A: p.A, B: p.B, y0, h: an.h, esp: 0.18, mat: an.mat, aberturas: ab[p.key] || [], nx: p.nx, nz: p.nz, andar: a, r });
      }
      this._colBox(casa, 0, y0 + an.h * 0.5, 0, aw, an.h, ad, surfaceOf(an.mat));
      const gm = chamferBox(aw - 0.4, an.h - 0.08, ad - 0.4, 0.02);
      this.bat.add(gm, this._mat(casa, 0, y0 + an.h * 0.5, 0, 0), 'borracha', { uvScale: 2 });
      const gl2 = chamferBox(aw + 0.4, 0.2, ad + 0.4, 0.03);
      this.bat.add(gl2, this._mat(casa, 0, y0 + an.h + 0.1, 0, 0), 'concreto', { uvScale: 1 });
      this._colBox(casa, 0, y0 + an.h + 0.1, 0, aw + 0.4, 0.2, ad + 0.4, 'concreto');
      casa.alturaTotal = y0 + an.h + 0.2;
    }
    this._topo(casa, r);
  }

  // -------------------------------------------------------------- paredes

  /** Distribui janelas/portas por parede segundo a orientaçao e o andar. */
  _planejarAberturas(casa, andar, w, d, r) {
    const out = {};
    const frenteKey = casa.frenteZ === -1 ? 'z-' : 'z+';
    const lados = [
      { key: 'z-', comp: w }, { key: 'z+', comp: w },
      { key: 'x-', comp: d }, { key: 'x+', comp: d },
    ];
    for (const l of lados) {
      const arr = [];
      const ehFrente = l.key === frenteKey;
      // paredes coladas no vizinho (fundo) recebem menos janela
      const chanceJanela = ehFrente ? 0.95 : (l.key.startsWith('x') ? 0.82 : 0.58);
      const util = l.comp - 1.0;
      const n = Math.max(0, Math.floor(util / r.range(1.9, 2.8)));
      for (let i = 0; i < n; i++) {
        if (!r.chance(chanceJanela)) continue;
        const u = 0.5 + (util) * ((i + 0.5) / Math.max(1, n)) + r.range(-0.2, 0.2);
        const jw = r.range(0.85, 1.45);
        const jh = r.range(0.95, 1.30);
        const sill = r.range(0.95, 1.20);
        if (u - jw / 2 < 0.45 || u + jw / 2 > l.comp - 0.45) continue;
        arr.push({ u, w: jw, sill, h: jh, tipo: 'janela' });
      }
      if (andar === 0 && ehFrente) {
        const pu = l.comp * r.range(0.28, 0.72);
        const pw = 0.92;
        // remove janelas que colidem com a porta
        for (let i = arr.length - 1; i >= 0; i--) {
          if (Math.abs(arr[i].u - pu) < (arr[i].w + pw) * 0.5 + 0.2) arr.splice(i, 1);
        }
        if (pu - pw / 2 > 0.35 && pu + pw / 2 < l.comp - 0.35) {
          arr.push({ u: pu, w: pw, sill: 0, h: r.range(2.0, 2.15), tipo: 'porta' });
        }
      }
      arr.sort((a, b) => a.u - b.u);
      out[l.key] = arr;
    }
    return out;
  }

  /** Gera uma parede com aberturas como faixas de alvenaria (sem booleana). */
  _parede(casa, o) {
    const { A, B, y0, h, esp, mat, aberturas, nx, nz, andar, r } = o;
    const ux = B[0] - A[0], uz = B[1] - A[1];
    const L = Math.hypot(ux, uz);
    if (L < 0.3) return;
    const dx = ux / L, dz = uz / L;
    const yawP = Math.atan2(-dz, dx);
    const tilt = r.range(-0.006, 0.006);
    const taper = r.range(0.002, 0.012);

    const seg = (a, b, ya, yb, matName, espLocal = esp, extra = null) => {
      const compr = b - a, alt = yb - ya;
      if (compr < 0.02 || alt < 0.02) return;
      const mid = (a + b) * 0.5;
      const px = A[0] + dx * mid, pz = A[1] + dz * mid;
      const g = chamferBox(compr, alt, espLocal, 0.025, extra ?? { tiltX: tilt, taper });
      _m.makeRotationY(yawP);
      _m.setPosition(px, (ya + yb) * 0.5, pz);
      _m.premultiply(_mHouse);
      this.bat.add(g, _m, matName, { uvScale: 1 });
    };

    let cursor = 0;
    for (const ab of aberturas) {
      const a0 = ab.u - ab.w * 0.5, a1 = ab.u + ab.w * 0.5;
      seg(cursor, a0, y0, y0 + h, mat);
      if (ab.sill > 0.02) seg(a0, a1, y0, y0 + ab.sill, mat);          // peitoril
      seg(a0, a1, y0 + ab.sill + ab.h, y0 + h, mat);                    // verga
      cursor = a1;

      // moldura de concreto (verga e contraverga aparentes) + ancora
      const cu = ab.u;
      const px = A[0] + dx * cu, pz = A[1] + dz * cu;
      const yJ = y0 + ab.sill + ab.h * 0.5;
      const gv = chamferBox(ab.w + 0.18, 0.10, esp + 0.06, 0.015);
      _m.makeRotationY(yawP); _m.setPosition(px, y0 + ab.sill + ab.h + 0.05, pz); _m.premultiply(_mHouse);
      this.bat.add(gv, _m, 'concreto_liso', { uvScale: 0.8 });
      if (ab.sill > 0.02) {
        const gs = chamferBox(ab.w + 0.18, 0.07, esp + 0.10, 0.012);
        _m.makeRotationY(yawP); _m.setPosition(px, y0 + ab.sill - 0.035, pz + 0); _m.premultiply(_mHouse);
        this.bat.add(gs, _m, 'concreto_liso', { uvScale: 0.8 });
      }

      const mundo = this._pt(casa, px, yJ, pz);
      const nrm = this._dir(casa, nx, nz);
      if (ab.tipo === 'janela') {
        this.ancoras.janelas.push({ ...mundo, nx: nrm.x, nz: nrm.z, w: ab.w, h: ab.h, andar, sillY: mundo.y - ab.h * 0.5 });
        // grade de ferro
        _m.makeRotationY(yawP);
        _m.setPosition(px + nx * (esp * 0.5 + 0.03), yJ, pz + nz * (esp * 0.5 + 0.03));
        _m.premultiply(_mHouse);
        _m.scale(new THREE.Vector3(ab.w / 1.0, ab.h / 1.0, 1));
        this.bat.pushInstance('grade', _m);
        // vidro recuado
        _m.makeRotationY(yawP);
        _m.setPosition(px - nx * esp * 0.35, yJ, pz - nz * esp * 0.35);
        _m.premultiply(_mHouse);
        _m.scale(new THREE.Vector3(ab.w * 0.94, ab.h * 0.94, 1));
        this.bat.pushInstance('vidro', _m);
      } else {
        this.ancoras.portas.push({ ...mundo, nx: nrm.x, nz: nrm.z });
        // porta de madeira/ferro recuada
        const gp = chamferBox(ab.w - 0.06, ab.h - 0.04, 0.045, 0.008);
        _m.makeRotationY(yawP);
        _m.setPosition(px - nx * esp * 0.28, y0 + ab.h * 0.5, pz - nz * esp * 0.28);
        _m.premultiply(_mHouse);
        this.bat.add(gp, _m, r.chance(0.5) ? 'madeira' : 'metal_pintado', { uvScale: 0.7 });
      }
    }
    seg(cursor, L, y0, y0 + h, mat);

    // registra fachada larga e baixa como candidata a pichaçao
    if (andar === 0 && L > 2.6) {
      const cm = this._pt(casa, (A[0] + B[0]) * 0.5, y0 + 1.1, (A[1] + B[1]) * 0.5);
      const nrm = this._dir(casa, nx, nz);
      this.ancoras.fachadas.push({ ...cm, nx: nrm.x, nz: nrm.z, w: L, h: h, yaw: casa.yaw + yawP });
    }
  }

  _colParede(casa, p, y0, h, esp, mat) {
    const ux = p.B[0] - p.A[0], uz = p.B[1] - p.A[1];
    const L = Math.hypot(ux, uz);
    const mx = (p.A[0] + p.B[0]) * 0.5, mz = (p.A[1] + p.B[1]) * 0.5;
    const yawP = Math.atan2(-uz, ux);
    // converte para mundo
    const w = this._pt(casa, mx, y0 + h * 0.5, mz);
    this.col.addBox(w.x, w.y, w.z, L, h, esp, casa.yaw + yawP, surfaceOf(mat));
  }

  // --------------------------------------------------------------- extras

  _pilotis(casa, r) {
    const h = casa.desnivel + 0.6;
    const cols = [
      [-casa.w * 0.5 + 0.3, -casa.d * 0.5 + 0.3], [casa.w * 0.5 - 0.3, -casa.d * 0.5 + 0.3],
      [-casa.w * 0.5 + 0.3, casa.d * 0.5 - 0.3], [casa.w * 0.5 - 0.3, casa.d * 0.5 - 0.3],
    ];
    if (casa.w > 7) { cols.push([0, -casa.d * 0.5 + 0.3], [0, casa.d * 0.5 - 0.3]); }
    for (const [lx, lz] of cols) {
      const p = this._pt(casa, lx, 0, lz);
      const chao = this.terrain.heightAt(p.x, p.z);
      const alt = Math.max(0.4, casa.baseY - chao + 0.4);
      const g = chamferBox(0.24, alt, 0.24, 0.02);
      this.bat.add(g, this._mat(casa, lx, -alt * 0.5 + 0.15, lz, 0), 'concreto', { uvScale: 1 });
      this.col.addBox(p.x, casa.baseY - alt * 0.5 + 0.15, p.z, 0.24, alt, 0.24, casa.yaw, 'concreto');
    }
    // fechamento do vao sob a casa: sempre no lado que mais desce (senao da para
    // ver o mundo por baixo da favela, que e o erro classico de casa em palafita)
    let pior = null, piorGap = 0;
    for (const [lx, lz, w2, d2] of [
      [0, -casa.d * 0.5 + 0.06, casa.w, 0.12], [0, casa.d * 0.5 - 0.06, casa.w, 0.12],
      [-casa.w * 0.5 + 0.06, 0, 0.12, casa.d], [casa.w * 0.5 - 0.06, 0, 0.12, casa.d],
    ]) {
      const p = this._pt(casa, lx, 0, lz);
      const gap = casa.baseY - this.terrain.heightAt(p.x, p.z);
      if (gap > piorGap) { piorGap = gap; pior = [lx, lz, w2, d2]; }
    }
    if (pior && piorGap > 0.5) {
      const [lx, lz, w2, d2] = pior;
      const alt = piorGap + 0.25;
      const mat = r.weighted(['madeira', 'tijolo', 'metal_ondulado'], [0.35, 0.4, 0.25]);
      const g = chamferBox(Math.max(w2, 0.1) * 0.94, alt, Math.max(d2, 0.1) * 0.94, 0.02);
      this.bat.add(g, this._mat(casa, lx, -alt * 0.5 + 0.12, lz, 0), mat, { uvScale: 1 });
      const p = this._pt(casa, lx, -alt * 0.5 + 0.12, lz);
      this.col.addBox(p.x, p.y, p.z, Math.max(w2, 0.1), alt, Math.max(d2, 0.1), casa.yaw, 'madeira');
    }
  }

  _topo(casa, r) {
    const yTopo = casa.alturaTotal + 0.22;
    const ult = casa.andares[casa.andares.length - 1];
    const w = ult.w + ult.lajeSalto * 2, d = ult.d + ult.lajeSalto * 2;
    const cx = ult.desloc[0], cz = ult.desloc[1];
    const ya = ult.yaw || 0;   // o topo herda o giro do ultimo andar

    if (casa.topo === 'laje') {
      this.ancoras.lajes.push({ ...this._pt(casa, cx, yTopo, cz), w: w - 0.6, d: d - 0.6, yaw: casa.yaw + ya, casa });
      // mureta em 1-3 lados (nunca nos quatro: sempre falta dinheiro)
      const lados = [[0, -1], [0, 1], [-1, 0], [1, 0]];
      r.shuffle(lados);
      const n = r.int(1, 3);
      for (let i = 0; i < n; i++) {
        const [sx, sz] = lados[i];
        const hm = r.range(0.42, 0.95);
        const comp = sx !== 0 ? d : w;
        const g = chamferBox(sx !== 0 ? 0.14 : comp, hm, sx !== 0 ? comp : 0.14, 0.02, { taper: 0.01 });
        this.bat.add(g, this._mat(casa, cx + sx * (w * 0.5 - 0.07), yTopo + hm * 0.5, cz + sz * (d * 0.5 - 0.07), ya),
          r.chance(0.5) ? 'tijolo' : 'reboco', { uvScale: 1 });
        const p = this._pt(casa, cx + sx * (w * 0.5 - 0.07), yTopo + hm * 0.5, cz + sz * (d * 0.5 - 0.07));
        this.col.addBox(p.x, p.y, p.z, sx !== 0 ? 0.14 : comp, hm, sx !== 0 ? comp : 0.14, casa.yaw + ya, 'concreto');
      }
      // ferro de espera: a casa "esperando" o proximo andar
      if (casa.vergalhoes) {
        const nv = r.int(4, 9);
        for (let i = 0; i < nv; i++) {
          const lx = r.range(-w * 0.42, w * 0.42), lz = r.range(-d * 0.42, d * 0.42);
          const alt = r.range(0.35, 0.95);
          _m.makeRotationY(r.range(0, 6.28));
          _m.setPosition(cx + lx, yTopo + alt * 0.5 - 0.05, cz + lz);
          _m.premultiply(_mHouse);
          _m.scale(new THREE.Vector3(1, alt, 1));
          this.bat.pushInstance('vergalhao', _m);
        }
      }
      // casinha de escada / cômodo solto na laje
      if (r.chance(0.22)) {
        const cw = r.range(1.8, 2.6), cd = r.range(1.8, 2.6), ch = r.range(2.1, 2.5);
        const lx = r.range(-w * 0.2, w * 0.2), lz = r.range(-d * 0.2, d * 0.2);
        const g = chamferBox(cw, ch, cd, 0.025, { taper: 0.008 });
        this.bat.add(g, this._mat(casa, cx + lx, yTopo + ch * 0.5, cz + lz, ya),
          r.pick(['tijolo', 'reboco_azul', 'reboco_amarelo', 'reboco']), { uvScale: 1 });
        const p = this._pt(casa, cx + lx, yTopo + ch * 0.5, cz + lz);
        this.col.addBox(p.x, p.y, p.z, cw, ch, cd, casa.yaw + ya, 'tijolo');
        const gt = corrugatedSheet(cw + 0.3, cd + 0.3, 0.02, 0.16, 0.02);
        gt.rotateZ(r.range(0.1, 0.18));
        this.bat.add(gt, this._mat(casa, cx + lx, yTopo + ch + 0.1, cz + lz, ya), 'telha_fibrocimento', { uvScale: 1 });
      }
    } else {
      // telhado inclinado: fibrocimento ou barro
      const matTelha = casa.topo === 'barro' ? 'telha_barro' : 'telha_fibrocimento';
      const inc = r.range(0.14, 0.30);
      const duasAguas = r.chance(0.55);
      const beir = 0.32;
      // oitao (empena) de alvenaria fechando o vao do telhado
      const hMax = (duasAguas ? w * 0.5 : w) * inc;
      for (const sz of duasAguas ? [-1, 1] : [-1, 1]) {
        const g = triGeo(w, hMax, duasAguas);
        this.bat.add(g, this._mat(casa, cx, yTopo, cz + sz * (d * 0.5 - 0.08), ya), ult.mat, { uvScale: 1 });
      }
      if (duasAguas) {
        for (const s of [-1, 1]) {
          const larg = w * 0.5 + beir;
          const g = corrugatedSheet(larg, d + beir * 2, matTelha === 'telha_barro' ? 0.05 : 0.028,
            matTelha === 'telha_barro' ? 0.22 : 0.17, 0.04);
          g.rotateZ(-s * Math.atan(inc));
          const yy = yTopo + hMax * 0.5 + 0.05;
          this.bat.add(g, this._mat(casa, cx + s * (larg * 0.5 - beir * 0.3), yy, cz, ya), matTelha, { uvScale: 1 });
          const p = this._pt(casa, cx + s * (larg * 0.5 - beir * 0.3), yy, cz);
          this.ancoras.telhados.push({ x: p.x, y: p.y, z: p.z, w: larg, d: d, yaw: casa.yaw + ya, inc: -s * inc });
        }
      } else {
        const g = corrugatedSheet(w + beir * 2, d + beir * 2, 0.028, 0.17, 0.05);
        g.rotateZ(-Math.atan(inc));
        const yy = yTopo + hMax * 0.5 + 0.05;
        this.bat.add(g, this._mat(casa, cx, yy, cz, ya), matTelha, { uvScale: 1 });
        const p = this._pt(casa, cx, yy, cz);
        this.ancoras.telhados.push({ x: p.x, y: p.y, z: p.z, w: w + beir * 2, d: d + beir * 2, yaw: casa.yaw + ya, inc: -inc });
      }
      const pc = this._pt(casa, cx, yTopo + hMax * 0.35, cz);
      this.col.addBox(pc.x, pc.y, pc.z, w + beir, hMax * 0.8, d + beir, casa.yaw + ya, 'concreto');
    }
  }

  _escadaExterna(casa, r) {
    const alt = casa.andares[0].h + 0.25;
    const nDeg = Math.max(6, Math.round(alt / 0.175));
    const passo = 0.28;
    const compr = nDeg * passo;
    const lado = r.sign();
    const lx0 = -casa.w * 0.5 - 0.1;
    const lz0 = lado * (casa.d * 0.5 - 0.5);
    const dirZ = -lado;
    if (compr > casa.d - 0.6) return;
    for (let i = 0; i < nDeg; i++) {
      const y = (i + 1) * (alt / nDeg);
      const z = lz0 + dirZ * (i + 0.5) * passo;
      const g = chamferBox(1.0, y, passo, 0.015);
      this.bat.add(g, this._mat(casa, lx0 - 0.4, y * 0.5, z, 0), 'concreto', { uvScale: 1 });
    }
    const p = this._pt(casa, lx0 - 0.4, alt * 0.5, lz0 + dirZ * compr * 0.5);
    this.col.addBox(p.x, p.y - alt * 0.25, p.z, 1.0, alt * 0.5, compr, casa.yaw, 'concreto');
    this.col.addBox(p.x, p.y + alt * 0.2, p.z + 0, 1.0, alt * 0.4, compr * 0.55, casa.yaw, 'concreto');
    // guarda-corpo de cano
    const gg = chamferBox(0.05, 0.9, compr, 0.01);
    this.bat.add(gg, this._mat(casa, lx0 - 0.9, alt * 0.65, lz0 + dirZ * compr * 0.5, 0), 'metal_pintado', { uvScale: 0.5 });
  }

  // ------------------------------------------------------------ utilitarios

  /** Matriz local->mundo de um ponto/orientaçao da casa. */
  _mat(casa, lx, ly, lz, yawLocal) {
    _m.makeRotationY(yawLocal || 0);
    _m.setPosition(lx, ly, lz);
    return _m.premultiply(_mHouse);
  }

  /** Ponto local -> mundo. */
  _pt(casa, lx, ly, lz) {
    _v.set(lx, ly, lz).applyMatrix4(_mHouse);
    return { x: _v.x, y: _v.y, z: _v.z };
  }

  /** Direçao local -> mundo (so rotaçao em Y). */
  _dir(casa, nx, nz) {
    const c = Math.cos(casa.yaw), s = Math.sin(casa.yaw);
    return { x: nx * c + nz * s, z: -nx * s + nz * c };
  }

  _colBox(casa, lx, ly, lz, w, h, d, sup, yawLocal = 0) {
    const p = this._pt(casa, lx, ly, lz);
    this.col.addBox(p.x, p.y, p.z, w, h, d, casa.yaw + yawLocal, sup);
  }
}

// ------------------------------------------------------------------ helpers

/** Merge local simples (so position/normal) para prototipos de instancia. */
function mergeLocal(list) {
  let total = 0;
  for (const g of list) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3), nrm = new Float32Array(total * 3);
  let o = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, o);
    nrm.set(g.attributes.normal.array, o);
    o += g.attributes.position.count * 3;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return out;
}

/** Empena triangular (oitao) do telhado, com espessura. */
function triGeo(w, h, duasAguas) {
  const b = new TriBuilder();
  const t = 0.14;
  const topo = duasAguas ? [[0, h]] : [[w / 2, h]];
  const perfil = [[-w / 2, 0], ...topo, [w / 2, duasAguas ? 0 : h]];
  const face = duasAguas ? [[-w / 2, 0], [0, h], [w / 2, 0]] : [[-w / 2, 0], [w / 2, h], [w / 2, 0]];
  for (const s of [-1, 1]) {
    const pts = face.map(([x, y]) => [x, y, s * t * 0.5]);
    b.tri(pts[0], pts[1], pts[2], [0, 0, s]);
  }
  for (let i = 0; i < face.length; i++) {
    const a = face[i], c = face[(i + 1) % face.length];
    const ex = c[0] - a[0], ey = c[1] - a[1], el = Math.hypot(ex, ey) || 1;
    b.quad([a[0], a[1], -t / 2], [c[0], c[1], -t / 2], [c[0], c[1], t / 2], [a[0], a[1], t / 2], [ey / el, -ex / el, 0]);
  }
  void perfil;
  return b.build();
}

export { mergeLocal };
