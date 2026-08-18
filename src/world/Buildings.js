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
const _esc = new THREE.Vector3();

/** Folha de porta: tamanho do prototipo instanciado (ver `_defInstancias`). */
const PORTA_W = 0.86, PORTA_H = 2.07, PORTA_ESP = 0.045;

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
      portas: [],     // {x,y,z, nx,nz, casa, w,h}
    };
    /** Folhas de porta que abrem (so casas com interior jogavel). Ver Portas.js. */
    this.portas = [];
    /** Tamanho do prototipo instanciado da folha (o Portas escala a partir dele). */
    this.protoPorta = { w: PORTA_W, h: PORTA_H, esp: PORTA_ESP };
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

    /* Folha de porta que ABRE. Duas armadilhas resolvidas aqui:
     *
     * 1. O prototipo tem a DOBRADICA na origem (x de 0 a PROTO_W, y de 0 a
     *    PROTO_H). Assim girar a porta e so mexer no yaw da matriz da instancia
     *    — sem isso, girar em torno do centro faria a folha atravessar o batente.
     * 2. O prototipo nasce no tamanho MEDIO real (0,86 x 2,07 m) e nao unitario.
     *    `defineInstance` projeta a UV no prototipo, entao instancia escalada
     *    estica a textura; nascendo no tamanho certo a escala fica em ~1,00 e a
     *    madeira nao vira listra. */
    for (const [nome, mat] of [['portaMadeira', 'madeira'], ['portaFerro', 'metal_pintado']]) {
      b.defineInstance(nome, () => {
        const g = chamferBox(PORTA_W, PORTA_H, PORTA_ESP, 0.008);
        g.translate(PORTA_W * 0.5, PORTA_H * 0.5, 0);
        // macaneta: so um cilindro achatado, mas e o que diz "isto abre"
        const m = chamferBox(0.055, 0.055, 0.12, 0.012);
        m.translate(PORTA_W - 0.10, PORTA_H * 0.47, 0);
        return mergeLocal([g, m]);
      }, mat, { uvScale: 0.7 });
    }

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
    this.statsFuga = this.degrausDeFuga(casas);
  }

  // ------------------------------------------------- descida dos telhados

  /**
   * Degraus de fuga — garante que de TODO telhado se desce.
   *
   * ## O que a medicao mostrou (tools/casas.mjs, seed padrao)
   * Nenhum telhado do mapa era uma prisao absoluta: sempre dava para se atirar
   * la de cima. Mas em 189 das 293 casas a UNICA saida era um salto de 2,5 a
   * 5,0 m sem nenhum apoio no meio — 175 delas na faixa de 2,5 a 4 m. Para quem
   * esta em cima, isso e indistinguivel de estar preso: nao ha nada na tela que
   * diga que a queda e segura, e o jogador (com razao) nao pula.
   *
   * ## A correcao, e por que NAO e uma escada
   * Uma escadaria externa de 1 m de largura num beco de 1,3 m fecha o beco —
   * trocariamos um jogador preso em cima por outro preso embaixo. Por isso a
   * descida e feita de LAJE EM BALANCO: degraus de concreto saindo da parede,
   * empilhados em zigue-zague, todos ACIMA da altura da cabeca (folga de 1,95 m
   * medida do chao local). Quem passa no beco passa por baixo sem esbarrar;
   * quem esta na laje desce de degrau em degrau. E, no morro, essa e literalmente
   * a gambiarra que existe.
   *
   * O grafo abaixo e resolvido no PLANO (alturas de telhado + terreno), nao no
   * BVH — o BVH so e construido depois. Quem confere no BVH e a auditoria.
   */
  degrausDeFuga(casas) {
    /* 2,2 e nao 2,5 de proposito: este modelo roda no PLANO (cotas de telhado +
     * campo de altura) e a auditoria confere no BVH, onde entram beiral, mureta,
     * telha e o terreno decimado a 2 m. A margem de 30 cm e o que impede uma
     * casa de passar aqui por 5 cm e reprovar la. */
    const QUEDA_OK = 2.2;      // queda que ja conta como descida controlada
    const QUEDA_ALVO = 2.0;    // espacamento entre degraus
    const CLARO = 1.95;        // folga sob o degrau mais baixo (capsula tem 1,80)
    const ESP = 0.14;          // espessura da laje do degrau
    const SAIDA = 0.85;        // quanto o degrau avanca da face da parede
    const PROF = 1.4;          // profundidade do degrau (no eixo de saida)

    const uteis = casas.filter((c) => typeof c.telhadoY === 'number');
    const stats = { casas: uteis.length, tratadas: 0, degraus: 0, semLugar: 0 };
    if (!uteis.length) return stats;

    /** Ponto local (lx,lz) de uma casa -> mundo. */
    const pw = (c, lx, lz) => {
      const co = Math.cos(c.yaw), si = Math.sin(c.yaw);
      return [c.x + lx * co + lz * si, c.z - lx * si + lz * co];
    };
    const dentroDe = (px, pz, o, margem) => {
      const co = Math.cos(o.yaw), si = Math.sin(o.yaw);
      const dx = px - o.x, dz = pz - o.z;
      const lx = dx * co - dz * si, lz = dx * si + dz * co;
      return Math.abs(lx) <= o.w * 0.5 + margem && Math.abs(lz) <= o.d * 0.5 + margem;
    };
    /** O que ha embaixo do ponto (px,pz): outra casa ou o chao. */
    const pouso = (px, pz, self) => {
      let melhor = null;
      for (const o of uteis) {
        if (o === self || o.telhadoY >= self.telhadoY - 0.15) continue;
        if (!dentroDe(px, pz, o, 0.15)) continue;
        if (!melhor || o.telhadoY > melhor.telhadoY) melhor = o;
      }
      if (melhor) return { y: melhor.telhadoY, casa: melhor };
      return { y: this.terrain.heightAt(px, pz), casa: null };
    };

    /* Faces da casa: meio de cada parede, normal para fora e tangente ao longo
     * dela, tudo ja em mundo. A tangente e (nz, -nx) de proposito: e o eixo +X
     * local de uma caixa girada por `atan2(nx, nz)`, que e como o degrau vai ser
     * posicionado — assim o deslocamento lateral usa o mesmo eixo da geometria.
     *
     * `beiral` = quanto a LAJE passa da parede naquela direcao. Tudo abaixo e
     * medido a partir da beirada do telhado, nao da parede. */
    const faces = (c) => {
      const co = Math.cos(c.yaw), si = Math.sin(c.yaw);
      const tw = c.telhadoW ?? c.w, td = c.telhadoD ?? c.d;
      const ox = c.telhadoCx ?? 0, oz = c.telhadoCz ?? 0;
      return [
        { l: [0, -c.d * 0.5], n: [0, -1], comp: c.w, beiral: (td * 0.5 - oz) - c.d * 0.5 },
        { l: [0, c.d * 0.5], n: [0, 1], comp: c.w, beiral: (td * 0.5 + oz) - c.d * 0.5 },
        { l: [-c.w * 0.5, 0], n: [-1, 0], comp: c.d, beiral: (tw * 0.5 - ox) - c.w * 0.5 },
        { l: [c.w * 0.5, 0], n: [1, 0], comp: c.d, beiral: (tw * 0.5 + ox) - c.w * 0.5 },
      ].map((f) => {
        const [px, pz] = pw(c, f.l[0], f.l[1]);
        const nx = f.n[0] * co + f.n[1] * si;
        const nz = -f.n[0] * si + f.n[1] * co;
        return {
          x: px, z: pz, nx, nz, tx: nz, tz: -nx, comp: f.comp,
          beiral: Math.max(0, f.beiral),
        };
      });
    };

    /* --- 1) quem ja desce? relaxacao ate estabilizar --- */
    const desce = new Map();
    for (const c of uteis) desce.set(c, false);
    /* Pousar "logo abaixo da beirada": 0,55 m alem do beiral.
     *
     * Antes a sonda ia a 1,0 m da PAREDE, e isso mentia duas vezes — passava por
     * baixo de beiral grande (dizendo que dava para descer numa laje que na
     * verdade estava embaixo do proprio telhado) e aceitava telhado vizinho do
     * outro lado de um beco de 1,2 m, que exige salto e nao queda. A 0,55 m da
     * beirada, o que a sonda encontra e o que a capsula encontra ao dar um passo
     * para fora. */
    const testaDescida = (c) => {
      for (const f of faces(c)) {
        const fora = f.beiral + 0.55;
        for (const t of [-0.3, 0, 0.3]) {
          const px = f.x + f.nx * fora + f.tx * t * f.comp;
          const pz = f.z + f.nz * fora + f.tz * t * f.comp;
          const p = pouso(px, pz, c);
          const q = c.telhadoY - p.y;
          if (q > QUEDA_OK || q < -0.45) continue;
          if (!p.casa || desce.get(p.casa)) return true;
        }
      }
      return false;
    };
    for (let iter = 0; iter < 6; iter++) {
      let mudou = false;
      for (const c of uteis) {
        if (desce.get(c)) continue;
        if (testaDescida(c)) { desce.set(c, true); mudou = true; }
      }
      if (!mudou) break;
    }

    /* --- 2) quem nao desce ganha degraus, do telhado mais BAIXO para o mais
     * alto: assim uma casa alta pode aproveitar a vizinha que acabou de ser
     * resolvida, em vez de cada uma construir a sua escada. --- */
    const pendentes = uteis.filter((c) => !desce.get(c)).sort((a, b) => a.telhadoY - b.telhadoY);
    for (const c of pendentes) {
      if (testaDescida(c)) { desce.set(c, true); continue; }

      /* Melhor face: a que tem espaco livre e o pouso mais ALTO (menos degraus).
       * `saida` sai da BEIRADA do telhado, para o degrau ficar debaixo da queda
       * e nao debaixo do beiral. */
      let alvo = null;
      for (const f of faces(c)) {
        const saida = f.beiral + SAIDA;
        let livre = true;
        for (const dd of [f.beiral + 0.3, saida, saida + PROF * 0.5 + 0.15]) {
          const px = f.x + f.nx * dd, pz = f.z + f.nz * dd;
          for (const o of uteis) {
            if (o === c) continue;
            if (dentroDe(px, pz, o, 0.1) && o.telhadoY > c.telhadoY - QUEDA_ALVO) { livre = false; break; }
          }
          if (!livre) break;
        }
        if (!livre) continue;
        const px = f.x + f.nx * saida, pz = f.z + f.nz * saida;
        const p = pouso(px, pz, c);
        if (p.casa && !desce.get(p.casa)) continue;         // pousar em telhado preso nao resolve
        if (!alvo || p.y > alvo.pouso.y) alvo = { f, pouso: p, saida };
      }
      if (!alvo) { stats.semLugar++; continue; }

      const larg = Math.min(1.3, Math.max(0.7, alvo.f.comp * 0.42));
      const lat = larg * 0.58;
      const nY = [];
      let y = alvo.pouso.y + CLARO + ESP;
      while (y < c.telhadoY - 0.45 && nY.length < 8) { nY.push(y); y += QUEDA_ALVO; }
      if (!nY.length) { desce.set(c, true); continue; }      // ja cabia sem degrau

      for (let k = 0; k < nY.length; k++) {
        const desloc = (k % 2 === 0 ? -1 : 1) * lat;
        const px = alvo.f.x + alvo.f.nx * alvo.saida + alvo.f.tx * desloc;
        const pz = alvo.f.z + alvo.f.nz * alvo.saida + alvo.f.tz * desloc;
        const yawD = Math.atan2(alvo.f.nx, alvo.f.nz);
        const yD = nY[k] - ESP * 0.5;
        const g = chamferBox(larg, ESP, PROF, 0.02, { taper: 0.02 });
        _m.makeRotationY(yawD);
        _m.setPosition(px, yD, pz);
        this.bat.add(g, _m, 'concreto', { uvScale: 1 });
        this.col.addBox(px, yD, pz, larg, ESP, PROF, yawD, 'concreto');
        // mao-francesa: o degrau em balanco precisa parecer que para em pe
        const gb = chamferBox(larg * 0.28, 0.34, 0.34, 0.015, { taper: 0.5 });
        _m.makeRotationY(yawD);
        _m.setPosition(px - alvo.f.nx * (PROF * 0.5 - 0.25), yD - 0.22, pz - alvo.f.nz * (PROF * 0.5 - 0.25));
        this.bat.add(gb, _m, 'concreto', { uvScale: 1 });
        stats.degraus++;
      }
      desce.set(c, true);
      stats.tratadas++;
    }
    return stats;
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
        for (const p of paredes) {
          this._colParede(casa, p, y0, h, esp, an.mat, aberturasPorParede[p.key] || []);
        }
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
        const pw = 0.92;
        /* Porta OBRIGATORIA quando a casa tem interior jogavel.
         *
         * Antes o vao so nascia se o sorteio de `pu` caisse dentro da faixa
         * util; numa fachada curta (a favela tem casa de 2,8 m de frente) ele
         * caia fora e a casa ficava sem porta nenhuma — interior sem saida, por
         * sorteio. Agora `pu` e GRAMPEADO na faixa valida e a porta so e
         * descartada se a fachada for estreita demais para caber o vao, caso em
         * que `_garantirPorta` procura outra parede. */
        const folga = pw / 2 + 0.35;
        let pu = l.comp * r.range(0.28, 0.72);
        if (casa.interior) pu = clamp(pu, folga, l.comp - folga);
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

    /* Rede de seguranca: casa com interior jogavel NUNCA sai daqui sem porta.
     * Se a fachada da frente nao comportou o vao, a parede mais larga recebe uma
     * porta no meio, custe o que custar — sem isso o interior e uma caixa
     * lacrada, que e exatamente o defeito que estamos consertando. */
    if (casa.interior && andar === 0) {
      const temPorta = lados.some((l) => (out[l.key] || []).some((a) => a.tipo === 'porta'));
      if (!temPorta) {
        const alvo = lados.slice().sort((a, b) => b.comp - a.comp)[0];
        const pw = Math.min(0.92, alvo.comp - 0.7);
        if (pw > 0.7) {
          const arr = out[alvo.key];
          const pu = alvo.comp * 0.5;
          for (let i = arr.length - 1; i >= 0; i--) {
            if (Math.abs(arr[i].u - pu) < (arr[i].w + pw) * 0.5 + 0.2) arr.splice(i, 1);
          }
          arr.push({ u: pu, w: pw, sill: 0, h: r.range(2.0, 2.15), tipo: 'porta' });
          arr.sort((a, b) => a.u - b.u);
        }
      }
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
        this.ancoras.portas.push({ ...mundo, nx: nrm.x, nz: nrm.z, casa, w: ab.w, h: ab.h });
        this._folhaPorta(casa, {
          ab, a0, a1, y0, h, esp, A, dx, dz, yawP, nx, nz, r,
        });
        this._soleira(casa, { ab, y0, h, esp, px, pz, nx, nz, yawP });
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

  /**
   * Colisao de uma parede de casa com interior jogavel.
   *
   * ## O defeito que esta funcao tinha (causa raiz do "porta fechada")
   * Ela adicionava UMA caixa macica do comprimento inteiro da parede. A porta e
   * as janelas existiam so na malha VISUAL — a colisao nao sabia dos vaos. Uma
   * casa com `interior` virava, na pratica, uma caixa lacrada: dava para ver a
   * porta e o corredor, e nao dava para atravessar nem para dentro nem para
   * fora. Medido em `tools/casas.mjs`: 22 de 26 casas com interior prendiam a
   * capsula (o BFS de caminhada nunca passava da parede).
   *
   * Agora a parede vira faixas: um bloco de cada lado do vao e a verga por
   * cima. O vao da porta fica LIVRE do piso ate a verga — e por onde se entra e
   * se sai. Janela nao vira buraco: o peitoril continua macico e a colisao dela
   * fecha por cima do peitoril, senao a casa viraria um queijo por onde se
   * atravessa parede agachado.
   */
  /**
   * Folha de porta recuada no batente, como instancia com dobradica na origem.
   *
   * Publica em `this.portas` o que a casa com interior jogavel precisa para a
   * folha GIRAR depois (ver `src/world/Portas.js`): eixo, yaw fechado, sentido
   * de abertura e o indice da instancia. Casa macica ganha a mesma folha, so
   * que nunca registrada — ali a porta e cenario, porque atras dela ha bloco
   * solido e abrir nao levaria a lugar nenhum.
   *
   * Sentido: a porta abre para DENTRO. Numa viela de 1,3 m uma folha abrindo
   * para fora entala no muro da frente e vira o proximo motivo de o jogador
   * ficar preso.
   */
  _folhaPorta(casa, o) {
    const { ab, a0, a1, y0, esp, A, dx, dz, yawP, nx, nz, r } = o;
    const lw = ab.w - 0.06, lh = ab.h - 0.04;
    // dobradica num dos batentes (sorteada, so por variedade)
    const ladoDir = r.chance(0.5);
    const uH = ladoDir ? a0 : a1;
    const yawBase = casa.yaw + yawP + (ladoDir ? 0 : Math.PI);
    /* Interior = +Z local da parede (o normal de fora e -Z local, ver
     * `_planejarAberturas`). Girar +90 graus leva o +X local para o -Z local,
     * ou seja, para FORA; entao dentro e -90. Com a dobradica no outro batente
     * o referencial inteiro gira 180 e o sinal inverte junto. */
    const sentido = ladoDir ? -1 : 1;

    const rec = esp * 0.28;
    const eixo = this._pt(casa, A[0] + dx * uH - nx * rec, y0 + 0.02, A[1] + dz * uH - nz * rec);
    const nome = r.chance(0.5) ? 'portaMadeira' : 'portaFerro';

    _m.makeRotationY(yawBase);
    _m.setPosition(eixo.x, eixo.y, eixo.z);
    _m.scale(_esc.set(lw / PORTA_W, lh / PORTA_H, 1));
    const idx = this.bat.pushInstance(nome, _m);

    if (!casa.interior) return;
    const nrm = this._dir(casa, nx, nz);
    this.portas.push({
      casa, inst: nome, idx,
      eixo: { x: eixo.x, y: eixo.y, z: eixo.z },
      yawBase, sentido, w: lw, h: lh, esp: PORTA_ESP,
      nx: nrm.x, nz: nrm.z,          // normal para FORA, ja em mundo
    });
  }

  /**
   * Soleira — os degraus de concreto na frente da porta.
   *
   * ## Porque isto existe (medido em tools/porta.mjs)
   * A casa assenta em `baseY = min + 0,62*(max-min)` e o terreno so e achatado
   * de leve sob ela, entao o chao do beco chega a ficar 0,75 m ABAIXO do piso do
   * terreo. Resultado, na casa #83: com o vao ja aberto na colisao e a porta
   * escancarada, a capsula ainda era barrada na saida — o degrau de 0,74 m e
   * quase o dobro do `stepHeight` de 0,40 m e obriga a um mantle so para entrar
   * em casa. Visualmente a porta ficava pendurada acima do chao.
   *
   * Dois ou tres degraus resolvem, e e exatamente o que existe na porta de toda
   * casa de morro. Sao os mesmos degraus que servem de apoio para descer.
   */
  _soleira(casa, o) {
    const { ab, y0, h, esp, px, pz, nx, nz, yawP } = o;
    const pisoY = casa.baseY + y0 + (casa.interior ? 0.06 + h * 0.05 : 0.02);

    /* Chao de fora: o PIOR de quatro amostras, nao uma so.
     *
     * `Favela._aceitarCasa` achata so 94% da planta, de proposito — e o que faz
     * o terreno "vazar" nas bordas em vez de a casa virar um bolo numa bandeja.
     * O efeito colateral e um entalhe logo na saida: na casa #125 o piso interno
     * esta em 25,10 m, a 10 cm da parede o chao esta em 23,90 e meio metro
     * adiante volta a 24,76. Uma amostra so pegava os 24,76, o degrau saia curto
     * e o buraco continuava la. */
    let chaoY = Infinity;
    for (const dd of [0.15, 0.45, 0.75, 1.05]) {
      const p1 = this._pt(casa, px + nx * (esp * 0.5 + dd), 0, pz + nz * (esp * 0.5 + dd));
      chaoY = Math.min(chaoY, this.terrain.heightAt(p1.x, p1.z));
    }
    const queda = pisoY - chaoY;
    if (queda < 0.28) return;

    const n = Math.min(5, Math.max(1, Math.round(queda / 0.26)));
    const larg = Math.min(1.35, ab.w + 0.42);
    const prof = 0.34;
    const yawM = casa.yaw + yawP;
    for (let i = 0; i < n; i++) {
      /* Cada degrau e um bloco CHEIO, do proprio topo ate 0,6 m abaixo do ponto
       * mais fundo medido: assim ele tapa o entalhe em vez de flutuar sobre ele. */
      const topo = chaoY + (queda * (i + 1)) / n;
      const alt = topo - chaoY + 0.6;
      const fora = esp * 0.5 + prof * (n - i) - prof * 0.5;
      const p = this._pt(casa, px + nx * fora, 0, pz + nz * fora);
      const g = chamferBox(larg, alt, prof, 0.02, { taper: 0.01 });
      _m.makeRotationY(yawM);
      _m.setPosition(p.x, topo - alt * 0.5, p.z);
      this.bat.add(g, _m, 'concreto', { uvScale: 1 });
      this.col.addBox(p.x, topo - alt * 0.5, p.z, larg, alt, prof, yawM, 'concreto');
    }
  }

  _colParede(casa, p, y0, h, esp, mat, aberturas = []) {
    const ux = p.B[0] - p.A[0], uz = p.B[1] - p.A[1];
    const L = Math.hypot(ux, uz);
    if (L < 0.05) return;
    const dx = ux / L, dz = uz / L;
    const yawP = Math.atan2(-uz, ux);
    const sup = surfaceOf(mat);
    const yawM = casa.yaw + yawP;

    /** Faixa de parede entre `a` e `b` (metros ao longo da parede), de ya a yb. */
    const faixa = (a, b, ya, yb) => {
      const comp = b - a, alt = yb - ya;
      if (comp < 0.02 || alt < 0.02) return;
      const mid = (a + b) * 0.5;
      const w = this._pt(casa, p.A[0] + dx * mid, (ya + yb) * 0.5, p.A[1] + dz * mid);
      this.col.addBox(w.x, w.y, w.z, comp, alt, esp, yawM, sup);
    };

    // so a PORTA abre vao na colisao; janela fecha por cima do peitoril
    const vaos = aberturas
      .filter((ab) => ab.tipo === 'porta')
      .map((ab) => [ab.u - ab.w * 0.5, ab.u + ab.w * 0.5])
      .sort((a, b) => a[0] - b[0]);

    /* O vao vai do piso ao TETO do andar, e nao ate a verga desenhada.
     *
     * Medido em `tools/porta.mjs` (casa #100): o terreno do beco sobe 0,33 m ao
     * longo da soleira, entao quem estava do lado de fora tinha 1,77 m de pe-
     * direito sob uma verga desenhada a 2,10 m do piso INTERNO — menos que a
     * capsula de 1,80 m. A casa ficava lacrada por causa de 3 cm de cabeca.
     * Com o vao inteiro na colisao a passagem e sempre limpa; a verga continua
     * na malha visual, e passa 9 cm acima do olho (1,68 m) no pior caso, entao
     * nao ha nada errado para ver. Acima de `y0 + h` quem fecha e a laje. */
    let cursor = 0;
    for (const [a0, a1] of vaos) {
      faixa(cursor, Math.max(cursor, a0), y0, y0 + h);
      cursor = Math.max(cursor, a1);
    }
    faixa(cursor, L, y0, y0 + h);
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

    /* Cota e PLANTA da superficie que da para pisar la em cima.
     *
     * A planta importa tanto quanto a cota: o ultimo andar pode AVANCAR sobre o
     * terreo (`recuoX` negativo, o puxadinho em balanco) e a laje ainda sobra o
     * beiral por cima disso. Medindo a descida pela planta do TERREO, o degrau
     * de fuga nascia debaixo do beiral — o jogador caia da beirada e passava ao
     * lado dele. Ver `degrausDeFuga`. */
    casa.telhadoY = casa.baseY + yTopo;
    casa.telhadoW = w; casa.telhadoD = d;
    casa.telhadoCx = cx; casa.telhadoCz = cz;

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
      // o telhado inclinado tem colisao de CAIXA: quem anda la em cima anda no topo dela
      casa.telhadoY = casa.baseY + yTopo + hMax * 0.75;
      casa.telhadoW = w + beir; casa.telhadoD = d + beir;
    }
  }

  /**
   * Escadaria externa de laje — a escada de fora que toda casa de morro tem.
   *
   * ## O defeito que ela tinha (causa raiz do "subiu e nao desce")
   * A malha visual tinha os degraus certos, de 17,5 cm. A COLISAO eram duas
   * caixas: uma de meia altura no comprimento todo e outra de 0,4 x altura em
   * 55% do comprimento. Ou seja: o jogador via uma escada e esbarrava num
   * degrau unico de ~1,4 m — cinco vezes o `stepHeight` de 0,40 m e acima do
   * mantle de 1,30 m. A escada existia so para a camera; ninguem subia nem
   * descia por ela.
   *
   * Agora cada degrau tem a sua caixa (mesma altura da malha), entao a colisao
   * concorda com o que se ve e a escada e caminho de verdade — nos dois sentidos.
   */
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
      // colisao degrau a degrau: sem isto a escada e so pintura
      this._colBox(casa, lx0 - 0.4, y * 0.5, z, 1.0, y, passo, 'concreto');
    }
    // patamar de chegada, colado na laje: evita o vao de um degrau no topo
    this._colBox(casa, lx0 - 0.4, alt - 0.1, lz0 + dirZ * (compr + 0.2), 1.0, 0.2, 0.5, 'concreto');
    casa.temEscada = true;
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
