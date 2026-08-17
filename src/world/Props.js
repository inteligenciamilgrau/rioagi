/**
 * Props — tudo que nao e casa nem planta, mas que faz o lugar ser O lugar:
 * pavimento, escadaria, muro pichado, poste torto, o emaranhado de fio (gato),
 * caixa d'agua azul, varal, parabolica, botequim, kombi enferrujada, campinho.
 *
 * Regra: se repete, e InstancedMesh; se e unico e estatico, vai para o merge.
 * Dono: WORLD.
 */
import * as THREE from 'three';
import { Rng, clamp, lerp } from './gen/rng.js';
import {
  chamferBox, simpleBox, chamferCylinder, corrugatedSheet, plane, catenary, tubeAlong,
  ribbon, TriBuilder,
} from './gen/geo.js';
import { mergeLocal } from './Buildings.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3(1, 1, 1);
const _p = new THREE.Vector3();
const _c = new THREE.Color();

const AZUL_CAIXA = new THREE.Color('#2b57a8');
const AZUL_GALAO = new THREE.Color('#1f6fb2');
const CORES_ROUPA = [
  '#d94f4f', '#e8c451', '#4f7fd9', '#54a86b', '#e8e2d8', '#d97fb0',
  '#3a3f4a', '#e07a3a', '#8ec9d4', '#b04a8a', '#f2efe6', '#5d6b3a',
];

export class Props {
  constructor({ rng, batcher, collision, terrain, favela, ancoras, quality }) {
    this.rng = rng;
    this.bat = batcher;
    this.col = collision;
    this.terrain = terrain;
    this.fav = favela;
    this.anc = ancoras;
    this.densidade = quality?.propDensity ?? 1;
    this.pontosCobertura = [];
    this._defInstancias();
  }

  _defInstancias() {
    const b = this.bat;

    // --- caixa d'agua azul: corpo com nervura + tampa ---
    b.defineInstance('caixaDagua', () => {
      const parts = [];
      parts.push(chamferCylinder(0.56, 0.50, 0.86, 10, 0.03));
      const nerv = chamferCylinder(0.585, 0.585, 0.05, 10, 0.012);
      nerv.translate(0, 0.12, 0); parts.push(nerv);
      const nerv2 = nerv.clone(); nerv2.translate(0, -0.26, 0); parts.push(nerv2);
      const tampa = chamferCylinder(0.30, 0.46, 0.13, 10, 0.02);
      tampa.translate(0, 0.49, 0); parts.push(tampa);
      const alca = chamferBox(0.16, 0.03, 0.05, 0.008); alca.translate(0, 0.57, 0); parts.push(alca);
      return mergeLocal(parts);
    }, 'plastico', { uvScale: 0.6 });

    // --- galao / bombona azul ---
    b.defineInstance('galao', () => {
      const parts = [chamferCylinder(0.24, 0.26, 0.62, 10, 0.02)];
      const t = chamferCylinder(0.09, 0.11, 0.07, 8, 0.01); t.translate(0.08, 0.34, 0); parts.push(t);
      return mergeLocal(parts);
    }, 'plastico', { uvScale: 0.5 });

    // --- botijao de gas P13 ---
    b.defineInstance('botijao', () => {
      const parts = [chamferCylinder(0.19, 0.19, 0.52, 10, 0.03)];
      const g = chamferCylinder(0.075, 0.075, 0.13, 8, 0.01); g.translate(0, 0.32, 0); parts.push(g);
      const al = chamferCylinder(0.14, 0.14, 0.05, 10, 0.01); al.translate(0, 0.36, 0); parts.push(al);
      return mergeLocal(parts);
    }, 'metal_pintado', { uvScale: 0.5 });

    // --- antena parabolica ---
    b.defineInstance('parabolica', () => {
      const g = new THREE.SphereGeometry(0.42, 12, 6, 0, Math.PI * 2, 0, 0.62);
      g.scale(1, 0.45, 1); g.rotateX(-Math.PI / 2 + 0.35);
      const parts = [g.toNonIndexed()];
      const braco = chamferBox(0.035, 0.5, 0.035, 0.008); braco.translate(0, -0.28, 0.16); parts.push(braco);
      const lnb = chamferBox(0.07, 0.07, 0.16, 0.012); lnb.translate(0, -0.02, 0.3); parts.push(lnb);
      return mergeLocal(parts);
    }, 'plastico', { uvScale: 0.5 });

    // --- antena de TV de varetas ---
    b.defineInstance('antenaTv', () => {
      const parts = [];
      const mastro = simpleBox(0.03, 1.5, 0.03); parts.push(mastro);
      for (let i = 0; i < 7; i++) {
        const y = 0.25 + i * 0.14;
        const len = 0.85 - i * 0.075;
        const v = simpleBox(len, 0.014, 0.014);
        v.translate(0, y, 0); parts.push(v);
      }
      return mergeLocal(parts);
    }, 'metal_ondulado', { uvScale: 0.4, castShadow: false });

    // --- cadeira de plastico ---
    b.defineInstance('cadeira', () => {
      const parts = [];
      const assento = chamferBox(0.42, 0.04, 0.42, 0.01); assento.translate(0, 0.44, 0); parts.push(assento);
      const encosto = chamferBox(0.42, 0.44, 0.04, 0.01); encosto.translate(0, 0.66, -0.19); parts.push(encosto);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const pe = chamferBox(0.035, 0.44, 0.035, 0.008);
        pe.translate(sx * 0.17, 0.22, sz * 0.17); parts.push(pe);
      }
      return mergeLocal(parts);
    }, 'plastico', { uvScale: 0.4 });

    // --- mesa de plastico ---
    b.defineInstance('mesa', () => {
      const parts = [];
      const t = chamferBox(0.72, 0.045, 0.72, 0.012); t.translate(0, 0.72, 0); parts.push(t);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const pe = chamferBox(0.04, 0.72, 0.04, 0.008);
        pe.translate(sx * 0.31, 0.36, sz * 0.31); parts.push(pe);
      }
      return mergeLocal(parts);
    }, 'plastico', { uvScale: 0.4 });

    // --- engradado de cerveja ---
    b.defineInstance('engradado', () => {
      const parts = [chamferBox(0.4, 0.28, 0.28, 0.012)];
      return mergeLocal(parts);
    }, 'plastico', { uvScale: 0.4, sectored: true, lodMax: 70 });

    // --- saco de lixo ---
    b.defineInstance('sacoLixo', () => {
      const g = new THREE.IcosahedronGeometry(0.32, 1);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const k = 1 + Math.sin(x * 9) * 0.11 + Math.cos(z * 7.3) * 0.09;
        p.setXYZ(i, x * k * 1.15, y * k * 0.82 + 0.26, z * k * 1.15);
      }
      g.computeVertexNormals();
      return g.toNonIndexed();
    }, 'plastico', { uvScale: 0.5, sectored: true, lodMax: 65 });

    // --- pedaço de tijolo/entulho ---
    b.defineInstance('entulho', () => {
      const g = new THREE.DodecahedronGeometry(0.16, 0);
      return g.toNonIndexed();
    }, 'concreto', { uvScale: 0.5, sectored: true, lodMax: 55 });

    // --- roupa no varal (pano com barriga de vento) ---
    b.defineInstance('roupa', () => {
      const g = plane(0.52, 0.68, 3, 3, 0.09);
      return g;
    }, 'pano', { uvScale: 0.7, castShadow: true, side: THREE.DoubleSide });

    // --- luminaria de poste ---
    b.defineInstance('luminaria', () => {
      const parts = [];
      const braco = chamferBox(0.9, 0.05, 0.05, 0.01); braco.translate(0.45, 0, 0); parts.push(braco);
      const cabeca = chamferBox(0.46, 0.13, 0.24, 0.03); cabeca.translate(0.86, -0.06, 0); parts.push(cabeca);
      return mergeLocal(parts);
    }, 'metal_pintado', { uvScale: 0.4 });

    // --- vaso de barro (a planta em cima vem do Vegetation) ---
    b.defineInstance('vaso', () => {
      const parts = [chamferCylinder(0.19, 0.13, 0.26, 8, 0.015)];
      const borda = chamferCylinder(0.21, 0.21, 0.04, 8, 0.01);
      borda.translate(0, 0.13, 0); parts.push(borda);
      return mergeLocal(parts);
    }, 'tijolo', { uvScale: 0.35, sectored: true, lodMax: 60 });

    // --- degrau/soleira de porta ---
    b.defineInstance('soleira', () => chamferBox(1.15, 0.14, 0.42, 0.02), 'concreto_liso',
      { uvScale: 0.6, sectored: true, lodMax: 75 });

    // --- pneu (reaproveitado do Buildings) e tijolo solto ja definidos la ---
  }

  construir() {
    this.vasos = [];              // posiçoes que o Vegetation vai plantar
    this.pavimento();
    this.escadarias();
    this.muros();
    this.postesEFios();
    this.lajesEquipadas();
    this.telhadosPesados();
    this.fachadas();
    this.varais();
    this.botequim();
    this.campinho();
    this.veiculos();
    this.entulhoEUrbano();
    this.coberturas();
  }

  /**
   * Detalhe de fachada na altura do olho — e o que separa "caixa pintada" de
   * "casa onde mora gente": toldo sobre a porta, soleira, vaso de planta,
   * descida de fio ate o relogio de luz.
   */
  fachadas() {
    const r = this.rng.fork('fachadas');
    for (const po of this.anc.portas) {
      const yaw = Math.atan2(po.nx, po.nz);
      // soleira
      _e.set(0, yaw, 0); _q.setFromEuler(_e);
      _m.compose(new THREE.Vector3(po.x + po.nx * 0.22, po.y - 1.02, po.z + po.nz * 0.22), _q, _s);
      this.bat.pushInstance('soleira', _m);
      // toldo de lona sobre a porta
      if (r.chance(0.3)) {
        const larg = r.range(1.3, 2.0);
        const g = corrugatedSheet(larg, 0.95, 0.02, 0.4, 0.07);
        g.rotateZ(0);
        g.rotateX(-r.range(0.16, 0.3));
        _m.makeRotationY(yaw);
        _m.setPosition(po.x + po.nx * 0.45, po.y + 1.28, po.z + po.nz * 0.45);
        this.bat.add(g, _m, r.chance(0.5) ? 'pano' : 'metal_ondulado', { uvScale: 1 });
        for (const s2 of [-1, 1]) {
          const sup = chamferBox(0.035, 0.035, 0.85, 0.008);
          _e.set(-0.5, yaw, 0); _q.setFromEuler(_e);
          const ox = Math.cos(yaw) * s2 * larg * 0.42, oz = -Math.sin(yaw) * s2 * larg * 0.42;
          _m.compose(new THREE.Vector3(po.x + ox + po.nx * 0.3, po.y + 1.42, po.z + oz + po.nz * 0.3), _q, _s);
          this.bat.add(sup, _m, 'metal_pintado', { uvScale: 0.4 });
        }
      }
      // vaso de planta ao lado da porta
      if (r.chance(0.34)) {
        const s2 = r.sign();
        const ox = Math.cos(yaw) * s2 * r.range(0.7, 1.1), oz = -Math.sin(yaw) * s2 * r.range(0.7, 1.1);
        const x = po.x + ox + po.nx * 0.35, z = po.z + oz + po.nz * 0.35;
        const y = this.terrain.heightAt(x, z);
        _e.set(0, r.range(0, 6.28), 0); _q.setFromEuler(_e);
        const esc = r.range(0.85, 1.35);
        _m.compose(new THREE.Vector3(x, y + 0.13 * esc, z), _q, new THREE.Vector3(esc, esc, esc));
        this.bat.pushInstance('vaso', _m);
        this.vasos.push({ x, y: y + 0.26 * esc, z, esc });
      }
    }
    // descida de fio: do beiral ate o relogio de luz da fachada
    for (const f of this.anc.fachadas) {
      if (!r.chance(0.28)) continue;
      const topo = f.y + r.range(3.4, 6.2);
      const lx = f.x + f.nx * 0.13 + Math.cos(Math.atan2(f.nx, f.nz)) * r.range(-1.4, 1.4);
      const lz = f.z + f.nz * 0.13 - Math.sin(Math.atan2(f.nx, f.nz)) * r.range(-1.4, 1.4);
      const pts = [
        new THREE.Vector3(lx, topo, lz),
        new THREE.Vector3(lx + r.range(-0.08, 0.08), (topo + f.y) * 0.5, lz + r.range(-0.08, 0.08)),
        new THREE.Vector3(lx, f.y + 0.4, lz),
      ];
      this.bat.add(tubeAlong(pts, 0.012, 3), null, 'borracha', { uvScale: 0.3, castShadow: false });
    }
  }

  // ------------------------------------------------------------- pavimento

  pavimento() {
    const hf = (x, z) => this.terrain.heightAt(x, z);
    for (const via of this.fav.vias) {
      if (via.tipo === 'rua') {
        const asf = ribbon(via.pts, via.w, hf, 0.045);
        this.bat.add(asf.geo, null, 'asfalto', { uvScale: 1 });
        this.col.addGeometry(asf.geo.clone(), null, 'asfalto');
        for (const s of [-1, 1]) {
          const eixo = deslocar(via.pts, s * (via.w * 0.5 + 0.82));
          const cal = ribbon(eixo, 1.55, hf, 0.175);
          this.bat.add(cal.geo, null, 'calcada_portuguesa', { uvScale: 1 });
          this.col.addGeometry(cal.geo.clone(), null, 'concreto');
          // meio-fio: faixa vertical entre o asfalto e a calçada
          const guia = deslocar(via.pts, s * (via.w * 0.5 + 0.05));
          const g = faixaVertical(guia, hf, 0.045, 0.175);
          this.bat.add(g, null, 'concreto_liso', { uvScale: 1 });
        }
      } else {
        // piso do beco: concreto grosseiro, so nos trechos que nao sao escada
        const trechos = trechosNaoEscada(via);
        for (const [i0, i1] of trechos) {
          if (i1 - i0 < 2) continue;
          const sub = via.pts.slice(i0, i1 + 1);
          const pr = ribbon(sub, via.w, hf, 0.035);
          this.bat.add(pr.geo, null, 'concreto', { uvScale: 1 });
          this.col.addGeometry(pr.geo.clone(), null, 'concreto');
        }
      }
    }
    // chao das praças
    for (const pr of this.fav.pracas) {
      const g = discoGeo(pr.x, pr.z, pr.r, hf, 0.05, 16);
      this.bat.add(g, null, 'calcada_portuguesa', { uvScale: 1 });
      this.col.addGeometry(g.clone(), null, 'concreto');
    }
  }

  /** Escadarias de concreto: o elemento que mais define circulaçao vertical aqui. */
  escadarias() {
    const r = this.rng.fork('escadas');
    for (const via of this.fav.vias) {
      if (!via.lances) continue;
      for (const [i0, i1] of via.lances) {
        const sub = via.pts.slice(i0, Math.min(via.pts.length, i1 + 1));
        if (sub.length < 3) continue;
        const passo = 0.30;
        const amostras = reamostrar(sub, passo);
        if (amostras.length < 3) continue;
        const yIni = this.terrain.heightAt(amostras[0][0], amostras[0][1]);
        const yFim = this.terrain.heightAt(amostras[amostras.length - 1][0], amostras[amostras.length - 1][1]);
        const subindo = yFim > yIni;
        const riser = 0.168;
        let yAtual = yIni;
        const larg = Math.max(0.9, via.w - 0.12);
        const patamar = r.chance(0.35) ? r.int(6, 12) : -1;

        // ---- perfil de degraus: y quantizado por espelho, monotonico ----
        const n = amostras.length;
        const alturas = new Float32Array(n);
        alturas[0] = yIni;
        for (let i = 1; i < n; i++) {
          const yTerr = this.terrain.heightAt(amostras[i][0], amostras[i][1]);
          const passos = Math.round((yTerr - yAtual) / (subindo ? riser : -riser));
          const avanca = (patamar > 0 && i % patamar === 0) ? 0 : Math.min(Math.max(passos, 0), 2);
          yAtual += (subindo ? riser : -riser) * avanca;
          alturas[i] = yAtual;
        }

        // ---- bordas laterais com tangente suavizada (evita o leque de quinas) ----
        const esq = [], dir = [];
        for (let i = 0; i < n; i++) {
          const a = amostras[Math.max(0, i - 2)], b = amostras[Math.min(n - 1, i + 2)];
          let dx = b[0] - a[0], dz = b[1] - a[1];
          const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
          const hw = larg * 0.5;
          esq.push([amostras[i][0] - dz * hw, amostras[i][1] + dx * hw]);
          dir.push([amostras[i][0] + dz * hw, amostras[i][1] - dx * hw]);
        }

        // ---- geometria varrida: piso, espelho e saia lateral, sem serrilhado ----
        const tb = new TriBuilder();
        for (let i = 0; i < n - 1; i++) {
          const y0 = alturas[i], y1 = alturas[i + 1];
          const eA = esq[i], eB = esq[i + 1], dA = dir[i], dB = dir[i + 1];
          // piso do degrau (plano na altura y0)
          tb.quad([eA[0], y0, eA[1]], [eB[0], y0, eB[1]], [dB[0], y0, dB[1]], [dA[0], y0, dA[1]], [0, 1, 0]);
          // espelho (parede vertical ate o proximo degrau)
          if (Math.abs(y1 - y0) > 1e-4) {
            const nx = eB[0] - eA[0], nz = eB[1] - eA[1];
            const nl = Math.hypot(nx, nz) || 1;
            tb.quad([eB[0], y0, eB[1]], [dB[0], y0, dB[1]], [dB[0], y1, dB[1]], [eB[0], y1, eB[1]],
              [nx / nl, 0, nz / nl]);
          }
          // saias laterais descendo ate o terreno (fecha a vista de lado)
          for (const [lado, sgn] of [[esq, 1], [dir, -1]]) {
            const pA = lado[i], pB = lado[i + 1];
            const baseA = Math.min(this.terrain.heightAt(pA[0], pA[1]), y0) - 0.35;
            const baseB = Math.min(this.terrain.heightAt(pB[0], pB[1]), y1) - 0.35;
            const nx = -(pB[1] - pA[1]), nz = (pB[0] - pA[0]);
            const nl = Math.hypot(nx, nz) || 1;
            tb.quad([pA[0], baseA, pA[1]], [pB[0], baseB, pB[1]], [pB[0], y1, pB[1]], [pA[0], y0, pA[1]],
              [sgn * nx / nl, 0, sgn * nz / nl]);
          }
          // colisao: uma caixa por degrau, alinhada a tangente local
          const cxm = (eA[0] + eB[0] + dA[0] + dB[0]) * 0.25;
          const czm = (eA[1] + eB[1] + dA[1] + dB[1]) * 0.25;
          const tx = amostras[i + 1][0] - amostras[i][0], tz = amostras[i + 1][1] - amostras[i][1];
          const alt = clamp(y0 - (this.terrain.heightAt(cxm, czm) - 0.4), 0.24, 1.5);
          this.col.addBox(cxm, y0 - alt * 0.5, czm, passo * 1.25, alt, larg,
            Math.atan2(-tz, tx), 'concreto');
        }
        this.bat.add(tb.build(), null, 'concreto', { uvScale: 1 });
        // corrimao de cano em parte dos lances
        if (r.chance(0.42)) {
          const lado = r.sign();
          const pts = [];
          for (let i = 0; i < amostras.length; i += 3) {
            const a = amostras[i];
            pts.push(new THREE.Vector3(a[0], alturas[i] + 0.92, a[1]));
          }
          if (pts.length > 2) {
            const off = via.w * 0.5 - 0.12;
            const desl = pts.map((v, i) => {
              const n = i < pts.length - 1 ? pts[i + 1].clone().sub(v) : v.clone().sub(pts[i - 1]);
              n.y = 0; n.normalize();
              return new THREE.Vector3(v.x - n.z * off * lado, v.y, v.z + n.x * off * lado);
            });
            this.bat.add(tubeAlong(desl, 0.024, 4), null, 'metal_pintado', { uvScale: 0.5 });
            for (let i = 0; i < desl.length; i += 2) {
              const b = desl[i];
              const hh = 0.92;
              const g = chamferBox(0.045, hh, 0.045, 0.008);
              _m.makeRotationY(0); _m.setPosition(b.x, b.y - hh * 0.5, b.z);
              this.bat.add(g, _m, 'metal_pintado', { uvScale: 0.5 });
            }
          }
        }
      }
    }
  }

  /** Muros de divisa e de arrimo, com pichaçao e caco de vidro no topo. */
  muros() {
    const r = this.rng.fork('muros');
    for (const mu of this.fav.muros) {
      const g = chamferBox(mu.len, mu.h, 0.22, 0.025, { taper: r.range(0, 0.02), tiltX: r.range(-0.005, 0.005) });
      _m.makeRotationY(mu.yaw);
      _m.setPosition(mu.x, mu.y + mu.h * 0.5, mu.z);
      this.bat.add(g, _m, mu.mat, { uvScale: 1 });
      this.col.addBox(mu.x, mu.y + mu.h * 0.5, mu.z, mu.len, mu.h, 0.22, mu.yaw, mu.arrimo ? 'concreto' : 'tijolo');
      // rufo/chapeu do muro
      const ch = chamferBox(mu.len + 0.08, 0.07, 0.3, 0.015);
      _m.makeRotationY(mu.yaw); _m.setPosition(mu.x, mu.y + mu.h + 0.035, mu.z);
      this.bat.add(ch, _m, 'concreto_liso', { uvScale: 0.8 });
      if (mu.grafite) {
        const pg = plane(mu.len * r.range(0.55, 0.95), Math.min(mu.h * 0.8, 1.9), 1, 1, 0);
        const lado = r.sign();
        _e.set(0, mu.yaw + (lado > 0 ? 0 : Math.PI), 0);
        _q.setFromEuler(_e);
        _p.set(mu.x + Math.sin(mu.yaw + Math.PI / 2) * 0 - (lado * Math.sin(mu.yaw) * 0), 0, 0);
        // desloca 11.5cm na normal do muro
        const nx = Math.cos(mu.yaw) * 0 + Math.sin(mu.yaw + Math.PI / 2) * 0;
        void nx;
        const dirX = -Math.sin(mu.yaw) * lado, dirZ = -Math.cos(mu.yaw) * lado;
        _m.compose(
          new THREE.Vector3(mu.x + dirX * 0.118, mu.y + mu.h * 0.48, mu.z + dirZ * 0.118),
          _q, _s,
        );
        this.bat.add(pg, _m, 'grafite', { uvScale: 1, castShadow: false });
      }
      if (mu.caco) {
        const n = Math.max(2, Math.round(mu.len / 0.5));
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) / n - 0.5;
          const lx = mu.x + Math.cos(mu.yaw) * t * mu.len;
          const lz = mu.z - Math.sin(mu.yaw) * t * mu.len;
          _e.set(r.range(-0.4, 0.4), r.range(0, 6.28), r.range(-0.3, 0.3));
          _q.setFromEuler(_e);
          _m.compose(new THREE.Vector3(lx, mu.y + mu.h + 0.13, lz), _q, _s);
          _m.scale(new THREE.Vector3(0.06, 0.17, 0.02));
          this.bat.pushInstance('vidro', _m);
        }
      }
      // ponto de cobertura atras do muro (normal aponta para FORA da cobertura)
      if (mu.h > 1.1) {
        const dirX = -Math.sin(mu.yaw), dirZ = -Math.cos(mu.yaw);
        this.pontosCobertura.push({
          position: new THREE.Vector3(mu.x - dirX * 0.85, mu.y, mu.z - dirZ * 0.85),
          normal: new THREE.Vector3(-dirX, 0, -dirZ), altura: mu.h, tipo: 'muro',
        });
      }
    }
  }

  // ------------------------------------------------------------ eletrica

  /** Postes + o gato: dezenas de fios baixos e caoticos cruzando o ceu. */
  postesEFios() {
    const r = this.rng.fork('fios');
    const topos = [];

    for (const po of this.fav.postes) {
      const g = chamferCylinder(0.11, 0.16, po.h, 8, 0.02);
      _e.set(po.tilt, po.yaw, po.tilt * 0.6);
      _q.setFromEuler(_e);
      _m.compose(new THREE.Vector3(po.x, po.y + po.h * 0.5, po.z), _q, _s);
      this.bat.add(g, _m, 'concreto', { uvScale: 1 });
      this.col.addBox(po.x, po.y + po.h * 0.5, po.z, 0.28, po.h, 0.28, po.yaw, 'concreto');

      const topoY = po.y + po.h - 0.5;
      // cruzeta de madeira com isoladores
      const cru = chamferBox(1.85, 0.09, 0.10, 0.012);
      _m.compose(new THREE.Vector3(po.x, topoY, po.z), _q, _s);
      this.bat.add(cru, _m, 'madeira', { uvScale: 0.6 });
      for (let i = 0; i < 4; i++) {
        const off = (i / 3 - 0.5) * 1.6;
        const iso = chamferCylinder(0.05, 0.06, 0.13, 6, 0.01);
        _m.compose(new THREE.Vector3(
          po.x + Math.cos(po.yaw) * off, topoY + 0.11, po.z - Math.sin(po.yaw) * off), _q, _s);
        this.bat.add(iso, _m, 'plastico', { uvScale: 0.4 });
      }
      if (po.trafo) {
        const tr = chamferCylinder(0.28, 0.28, 0.62, 10, 0.03);
        _m.compose(new THREE.Vector3(po.x + 0.22, topoY - 0.75, po.z), _q, _s);
        this.bat.add(tr, _m, 'metal_ondulado', { uvScale: 0.6 });
      }
      if (po.luminaria) {
        _e.set(0, po.yaw + r.range(-0.4, 0.4), 0.06); _q.setFromEuler(_e);
        _m.compose(new THREE.Vector3(po.x, po.y + po.h - 0.28, po.z), _q, _s);
        this.bat.pushInstance('luminaria', _m);
      }
      // caixa de emenda + rolo de fio sobrando (o "miolo" do gato)
      const cx = chamferBox(0.34, 0.42, 0.22, 0.02);
      _m.compose(new THREE.Vector3(po.x + 0.2, po.y + 3.1, po.z), _q, _s);
      this.bat.add(cx, _m, 'metal_pintado', { uvScale: 0.4 });
      const rolo = new THREE.TorusGeometry(0.3, 0.05, 5, 10);
      _e.set(Math.PI / 2, po.yaw, 0); _q.setFromEuler(_e);
      _m.compose(new THREE.Vector3(po.x + 0.14, po.y + 4.0, po.z), _q, _s);
      this.bat.add(rolo.toNonIndexed(), _m, 'borracha', { uv: 'keep', uvScale: 1.5 });

      for (let i = 0; i < 4; i++) {
        const off = (i / 3 - 0.5) * 1.6;
        topos.push(new THREE.Vector3(
          po.x + Math.cos(po.yaw) * off, topoY + 0.2, po.z - Math.sin(po.yaw) * off));
      }
      topos.push(new THREE.Vector3(po.x, po.y + 3.4, po.z));
    }

    // --- rede de fios ---
    const fios = [];
    const maxFios = Math.round(950 * clamp(this.densidade, 0.4, 1));
    const beirais = this.anc.beirais;

    // poste -> poste
    for (let i = 0; i < this.fav.postes.length; i++) {
      const a = this.fav.postes[i];
      const vizinhos = [];
      for (let j = 0; j < this.fav.postes.length; j++) {
        if (i === j) continue;
        const b = this.fav.postes[j];
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        if (d < 30) vizinhos.push({ j, d });
      }
      vizinhos.sort((p, q) => p.d - q.d);
      for (const v of vizinhos.slice(0, 3)) {
        if (v.j < i) continue;
        const b = this.fav.postes[v.j];
        const nf = r.int(3, 6);
        for (let k = 0; k < nf; k++) {
          const off = (k / Math.max(1, nf - 1) - 0.5) * 1.5;
          const dx = (b.x - a.x) / v.d, dz = (b.z - a.z) / v.d;
          const A = new THREE.Vector3(a.x - dz * off, a.y + a.h - 0.5 + r.range(-0.35, 0.25), a.z + dx * off);
          const B = new THREE.Vector3(b.x - dz * off, b.y + b.h - 0.5 + r.range(-0.35, 0.25), b.z + dx * off);
          fios.push({ A, B, sag: v.d * r.range(0.035, 0.085) + 0.15, raio: r.range(0.014, 0.026) });
        }
      }
    }

    // poste -> casa (a ligaçao clandestina)
    const usadosBeiral = new Set();
    for (const po of this.fav.postes) {
      let n = 0;
      const cand = [];
      for (let i = 0; i < beirais.length; i++) {
        const b = beirais[i];
        const d = Math.hypot(b.x - po.x, b.z - po.z);
        if (d < 17 && b.y > po.y + 1.0) cand.push({ i, d });
      }
      cand.sort((p, q) => p.d - q.d);
      for (const c of cand) {
        if (n >= 7) break;
        if (usadosBeiral.has(c.i) && r.chance(0.6)) continue;
        usadosBeiral.add(c.i);
        const b = beirais[c.i];
        const A = new THREE.Vector3(po.x + r.range(-0.4, 0.4), po.y + po.h - r.range(0.6, 2.6), po.z + r.range(-0.4, 0.4));
        const B = new THREE.Vector3(b.x, b.y + r.range(-0.35, 0.15), b.z);
        fios.push({ A, B, sag: c.d * r.range(0.05, 0.13) + 0.2, raio: r.range(0.010, 0.02) });
        n++;
      }
    }

    // casa -> casa (puxadinho eletrico)
    for (let i = 0; i < beirais.length; i += 2) {
      const a = beirais[i];
      for (let j = i + 1; j < Math.min(beirais.length, i + 26); j++) {
        const b = beirais[j];
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        if (d < 4 || d > 15) continue;
        if (!r.chance(0.16)) continue;
        fios.push({
          A: new THREE.Vector3(a.x, a.y - r.range(0, 0.4), a.z),
          B: new THREE.Vector3(b.x, b.y - r.range(0, 0.4), b.z),
          sag: d * r.range(0.07, 0.16) + 0.15, raio: r.range(0.009, 0.016),
        });
        break;
      }
    }

    r.shuffle(fios);
    const usar = fios.slice(0, maxFios);
    for (const f of usar) {
      const segs = Math.hypot(f.A.x - f.B.x, f.A.z - f.B.z) > 14 ? 8 : 5;
      const pts = catenary(f.A, f.B, f.sag, segs);
      this.bat.add(tubeAlong(pts, f.raio, 3), null, 'borracha', { uvScale: 0.4, castShadow: false });
    }
    this.statsFios = usar.length;
  }

  // --------------------------------------------------------------- lajes

  /** Caixa d'agua, antena, parabolica, entulho: a laje da favela e um deposito. */
  lajesEquipadas() {
    const r = this.rng.fork('lajes');
    for (const laje of this.anc.lajes) {
      const casa = laje.casa;
      const rot = (lx, lz) => {
        const c = Math.cos(laje.yaw), s = Math.sin(laje.yaw);
        return [laje.x + lx * c + lz * s, laje.z - lx * s + lz * c];
      };
      if (casa.caixaDagua) {
        const nCx = r.chance(0.22) ? 2 : 1;
        for (let i = 0; i < nCx; i++) {
          const lx = r.range(-laje.w * 0.35, laje.w * 0.35);
          const lz = r.range(-laje.d * 0.35, laje.d * 0.35) + i * 1.3;
          const [wx, wz] = rot(lx, lz);
          const esc = r.range(0.85, 1.25);
          // base de bloco sob a caixa
          const g = chamferBox(1.25 * esc, 0.22, 1.25 * esc, 0.02);
          _m.makeRotationY(laje.yaw); _m.setPosition(wx, laje.y + 0.11, wz);
          this.bat.add(g, _m, 'tijolo', { uvScale: 1 });
          _e.set(0, r.range(0, 6.28), 0); _q.setFromEuler(_e);
          _m.compose(new THREE.Vector3(wx, laje.y + 0.22 + 0.43 * esc, wz), _q,
            new THREE.Vector3(esc, esc, esc));
          this.bat.pushInstance('caixaDagua', _m, AZUL_CAIXA);
          this.col.addBox(wx, laje.y + 0.22 + 0.43 * esc, wz, 1.1 * esc, 0.86 * esc, 1.1 * esc, 0, 'plastico');
          this.pontosCobertura.push({
            position: new THREE.Vector3(wx, laje.y, wz),
            normal: new THREE.Vector3(1, 0, 0), altura: 1.1, tipo: 'caixa',
          });
        }
      }
      if (casa.parabolica) {
        const [wx, wz] = rot(r.range(-laje.w * 0.4, laje.w * 0.4), r.range(-laje.d * 0.4, laje.d * 0.4));
        _e.set(0, r.range(-2.6, -1.8), 0); _q.setFromEuler(_e);
        _m.compose(new THREE.Vector3(wx, laje.y + 0.55, wz), _q, _s);
        this.bat.pushInstance('parabolica', _m);
        const g = chamferBox(0.05, 0.6, 0.05, 0.01);
        _m.makeRotationY(0); _m.setPosition(wx, laje.y + 0.3, wz);
        this.bat.add(g, _m, 'metal_ondulado', { uvScale: 0.4 });
      }
      if (casa.antena) {
        const [wx, wz] = rot(r.range(-laje.w * 0.42, laje.w * 0.42), r.range(-laje.d * 0.42, laje.d * 0.42));
        _e.set(r.range(-0.08, 0.08), r.range(0, 6.28), r.range(-0.08, 0.08)); _q.setFromEuler(_e);
        _m.compose(new THREE.Vector3(wx, laje.y + 0.75, wz), _q, _s);
        this.bat.pushInstance('antenaTv', _m);
      }
      // entulho e galoes esquecidos
      const nEnt = r.int(0, 3);
      for (let i = 0; i < nEnt; i++) {
        const [wx, wz] = rot(r.range(-laje.w * 0.42, laje.w * 0.42), r.range(-laje.d * 0.42, laje.d * 0.42));
        _e.set(r.range(0, 6.28), r.range(0, 6.28), r.range(0, 6.28)); _q.setFromEuler(_e);
        _m.compose(new THREE.Vector3(wx, laje.y + 0.14, wz), _q, new THREE.Vector3(1, 0.7, 1));
        this.bat.pushInstance('entulho', _m);
      }
      if (r.chance(0.3)) {
        const [wx, wz] = rot(r.range(-laje.w * 0.4, laje.w * 0.4), r.range(-laje.d * 0.4, laje.d * 0.4));
        _e.set(0, r.range(0, 6.28), 0); _q.setFromEuler(_e);
        _m.compose(new THREE.Vector3(wx, laje.y + 0.31, wz), _q, _s);
        this.bat.pushInstance('galao', _m, AZUL_GALAO);
      }
      // ar-condicionado de janela e relogio de luz vem das ancoras de janela
    }

    // ar-condicionado + relogio de luz nas fachadas
    for (const j of this.anc.janelas) {
      if (!r.chance(0.055)) continue;
      _e.set(0, Math.atan2(j.nx, j.nz), 0); _q.setFromEuler(_e);
      _m.compose(new THREE.Vector3(j.x + j.nx * 0.22, j.y - j.h * 0.18, j.z + j.nz * 0.22), _q, _s);
      this.bat.pushInstance('arcond', _m);
    }
    for (const f of this.anc.fachadas) {
      if (!r.chance(0.12)) continue;
      _e.set(0, Math.atan2(f.nx, f.nz), 0); _q.setFromEuler(_e);
      _m.compose(new THREE.Vector3(f.x + f.nx * 0.14, f.y + 0.35, f.z + f.nz * 0.14), _q, _s);
      this.bat.pushInstance('relogioLuz', _m);
    }
    // pichaçao nas fachadas de terreo
    const rg = this.rng.fork('grafite');
    for (const f of this.anc.fachadas) {
      if (!rg.chance(0.3)) continue;
      const g = plane(Math.min(f.w * rg.range(0.5, 0.9), 4.2), rg.range(0.9, 1.7), 1, 1, 0);
      _e.set(0, Math.atan2(f.nx, f.nz), 0); _q.setFromEuler(_e);
      _m.compose(new THREE.Vector3(f.x + f.nx * 0.135, f.y + rg.range(-0.1, 0.5), f.z + f.nz * 0.135), _q, _s);
      this.bat.add(g, _m, 'grafite', { uvScale: 1, castShadow: false });
    }
  }

  /** Tijolo e pneu segurando telha de fibrocimento — assinatura absoluta. */
  telhadosPesados() {
    const r = this.rng.fork('telhado');
    for (const t of this.anc.telhados) {
      const n = r.int(3, 9);
      for (let i = 0; i < n; i++) {
        const lx = r.range(-t.w * 0.42, t.w * 0.42);
        const lz = r.range(-t.d * 0.42, t.d * 0.42);
        const c = Math.cos(t.yaw), s = Math.sin(t.yaw);
        const wx = t.x + lx * c + lz * s, wz = t.z - lx * s + lz * c;
        const wy = t.y + lx * t.inc + 0.06;
        _e.set(0, t.yaw + r.range(-0.6, 0.6), t.inc); _q.setFromEuler(_e);
        if (r.chance(0.45)) {
          _m.compose(new THREE.Vector3(wx, wy + 0.1, wz), _q, _s);
          this.bat.pushInstance('pneu', _m);
        } else {
          const pilha = r.int(1, 3);
          for (let k = 0; k < pilha; k++) {
            _m.compose(new THREE.Vector3(wx, wy + 0.05 + k * 0.095, wz), _q, _s);
            this.bat.pushInstance('tijoloSolto', _m);
          }
        }
      }
    }
  }

  /** Varais com roupa colorida entre janelas, lajes e postes. */
  varais() {
    const r = this.rng.fork('varal');
    const anc = this.anc.beirais.concat(
      this.anc.janelas.filter((j) => j.andar >= 1).map((j) => ({ x: j.x + j.nx * 0.3, y: j.y + 0.55, z: j.z + j.nz * 0.3 })),
    );
    let feitos = 0;
    const alvo = Math.round(230 * clamp(this.densidade, 0.4, 1));
    for (let i = 0; i < anc.length && feitos < alvo; i++) {
      if (!r.chance(0.45)) continue;
      const a = anc[i];
      let melhor = null, dmin = 9;
      for (let j = 0; j < anc.length; j++) {
        if (j === i) continue;
        const b = anc[j];
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        if (d > 2.4 && d < dmin && Math.abs(a.y - b.y) < 1.6) { dmin = d; melhor = b; }
      }
      if (!melhor) continue;
      const A = new THREE.Vector3(a.x, a.y - r.range(0.15, 0.7), a.z);
      const B = new THREE.Vector3(melhor.x, melhor.y - r.range(0.15, 0.7), melhor.z);
      const sag = dmin * 0.09 + 0.1;
      const pts = catenary(A, B, sag, 6);
      this.bat.add(tubeAlong(pts, 0.008, 3), null, 'borracha', { uvScale: 0.3, castShadow: false });
      const nR = Math.max(2, Math.round(dmin / r.range(0.6, 0.95)));
      for (let k = 0; k < nR; k++) {
        const t = (k + 0.5) / nR;
        const idx = t * (pts.length - 1);
        const i0 = Math.floor(idx), fr = idx - i0;
        const p0 = pts[i0], p1 = pts[Math.min(pts.length - 1, i0 + 1)];
        const px = lerp(p0.x, p1.x, fr), py = lerp(p0.y, p1.y, fr), pz = lerp(p0.z, p1.z, fr);
        const yaw = Math.atan2(B.x - A.x, B.z - A.z);
        _e.set(r.range(-0.1, 0.1), yaw + Math.PI / 2 + r.range(-0.25, 0.25), r.range(-0.12, 0.12));
        _q.setFromEuler(_e);
        const esc = r.range(0.75, 1.4);
        _m.compose(new THREE.Vector3(px, py - 0.34 * esc, pz), _q, new THREE.Vector3(esc, esc, 1));
        _c.set(r.pick(CORES_ROUPA));
        this.bat.pushInstance('roupa', _m, _c);
      }
      feitos++;
    }
    this.statsVarais = feitos;
  }

  // ------------------------------------------------------------- cenarios

  /** Botequim de esquina: balcao, geladeira de cerveja, toldo, mesa de plastico. */
  botequim() {
    const r = this.rng.fork('bar');
    const pracas = this.fav.pracas.slice(0, 3);
    for (let bi = 0; bi < pracas.length; bi++) {
      const pr = pracas[bi];
      const ang = r.range(0, 6.28);
      const bx = pr.x + Math.cos(ang) * (pr.r - 1.4);
      const bz = pr.z + Math.sin(ang) * (pr.r - 1.4);
      const by = this.terrain.heightAt(bx, bz);
      const yaw = Math.atan2(pr.x - bx, pr.z - bz);

      // balcao
      const balc = chamferBox(3.1, 1.06, 0.62, 0.02);
      _m.makeRotationY(yaw); _m.setPosition(bx, by + 0.53, bz);
      this.bat.add(balc, _m, 'azulejo', { uvScale: 1 });
      this.col.addBox(bx, by + 0.53, bz, 3.1, 1.06, 0.62, yaw, 'concreto');
      const tampo = chamferBox(3.3, 0.06, 0.78, 0.012);
      _m.makeRotationY(yaw); _m.setPosition(bx, by + 1.09, bz);
      this.bat.add(tampo, _m, 'concreto_liso', { uvScale: 0.8 });
      this.pontosCobertura.push({
        position: new THREE.Vector3(bx - Math.sin(yaw) * 0.95, by, bz - Math.cos(yaw) * 0.95),
        normal: new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)), altura: 1.1, tipo: 'balcao',
      });

      // geladeira de cerveja
      const gx = bx + Math.cos(yaw) * 2.2, gz = bz - Math.sin(yaw) * 2.2;
      const gel = chamferBox(0.86, 1.82, 0.7, 0.03);
      _m.makeRotationY(yaw); _m.setPosition(gx, by + 0.91, gz);
      this.bat.add(gel, _m, 'metal_pintado', { uvScale: 0.8 });
      const porta = plane(0.66, 1.4, 1, 1, 0);
      _e.set(0, yaw, 0); _q.setFromEuler(_e);
      _m.compose(new THREE.Vector3(gx + Math.sin(yaw) * 0.36, by + 1.0, gz + Math.cos(yaw) * 0.36), _q, _s);
      this.bat.add(porta, _m, 'vidro', { uvScale: 1, castShadow: false });
      this.col.addBox(gx, by + 0.91, gz, 0.86, 1.82, 0.7, yaw, 'metal');

      // toldo de lona
      const toldo = corrugatedSheet(4.6, 3.0, 0.02, 0.5, 0.16);
      toldo.rotateZ(0.13);
      _m.makeRotationY(yaw); _m.setPosition(bx + Math.sin(yaw) * 1.2, by + 2.55, bz + Math.cos(yaw) * 1.2);
      this.bat.add(toldo, _m, 'pano', { uvScale: 1 });
      for (const sx of [-1, 1]) {
        const px = bx + Math.cos(yaw) * sx * 2.1 + Math.sin(yaw) * 2.4;
        const pz = bz - Math.sin(yaw) * sx * 2.1 + Math.cos(yaw) * 2.4;
        const col = chamferBox(0.07, 2.5, 0.07, 0.012);
        _m.makeRotationY(yaw); _m.setPosition(px, by + 1.25, pz);
        this.bat.add(col, _m, 'metal_pintado', { uvScale: 0.5 });
      }

      // mesas e cadeiras
      const nMesas = r.int(2, 4);
      for (let i = 0; i < nMesas; i++) {
        const a2 = ang + r.range(-1.5, 1.5);
        const d2 = r.range(1.6, pr.r * 0.85);
        const mx = pr.x + Math.cos(a2) * d2, mz = pr.z + Math.sin(a2) * d2;
        const my = this.terrain.heightAt(mx, mz);
        _e.set(0, r.range(0, 6.28), 0); _q.setFromEuler(_e);
        _m.compose(new THREE.Vector3(mx, my, mz), _q, _s);
        this.bat.pushInstance('mesa', _m);
        this.col.addBox(mx, my + 0.5, mz, 0.75, 0.95, 0.75, 0, 'plastico');
        const nCad = r.int(2, 4);
        for (let k = 0; k < nCad; k++) {
          const ac = (k / nCad) * 6.28 + r.range(-0.4, 0.4);
          _e.set(0, ac + Math.PI, 0); _q.setFromEuler(_e);
          _m.compose(new THREE.Vector3(mx + Math.cos(ac) * 0.72, my, mz + Math.sin(ac) * 0.72), _q, _s);
          this.bat.pushInstance('cadeira', _m);
        }
      }
      // engradados empilhados
      const nEng = r.int(3, 8);
      for (let i = 0; i < nEng; i++) {
        const ex = bx + Math.cos(yaw) * r.range(-1.6, -1.0) + Math.sin(yaw) * r.range(0.4, 1.1);
        const ez = bz - Math.sin(yaw) * r.range(-1.6, -1.0) + Math.cos(yaw) * r.range(0.4, 1.1);
        const alt = Math.floor(i / 2);
        _e.set(0, yaw + r.range(-0.2, 0.2), 0); _q.setFromEuler(_e);
        _m.compose(new THREE.Vector3(ex, by + 0.14 + alt * 0.28, ez), _q, _s);
        this.bat.pushInstance('engradado', _m);
      }
      void bi;
    }
  }

  /** Campinho de varzea: terra batida, trave improvisada, linha de cal apagada. */
  campinho() {
    const r = this.rng.fork('campo');
    const cp = this.fav.campinho;
    const hf = (x, z) => this.terrain.heightAt(x, z);
    // piso de terra
    const g = retanguloColado(cp.x, cp.z, cp.w, cp.d, cp.yaw, hf, 0.04, 10, 7);
    this.bat.add(g, null, 'terra', { uvScale: 1 });
    this.col.addGeometry(g.clone(), null, 'terra');

    const c = Math.cos(cp.yaw), s = Math.sin(cp.yaw);
    const loc = (lx, lz) => [cp.x + lx * c + lz * s, cp.z - lx * s + lz * c];

    // traves de cano torto
    for (const sx of [-1, 1]) {
      const larg = 3.2, alt = 2.05;
      for (const sz of [-1, 1]) {
        const [px, pz] = loc(sx * (cp.w * 0.5 - 0.7), sz * larg * 0.5);
        const py = hf(px, pz);
        const col = chamferCylinder(0.05, 0.06, alt, 6, 0.012);
        _e.set(r.range(-0.05, 0.05), 0, r.range(-0.05, 0.05)); _q.setFromEuler(_e);
        _m.compose(new THREE.Vector3(px, py + alt * 0.5, pz), _q, _s);
        this.bat.add(col, _m, 'metal_pintado', { uvScale: 0.5 });
        this.col.addBox(px, py + alt * 0.5, pz, 0.12, alt, 0.12, 0, 'metal');
      }
      const [bx, bz] = loc(sx * (cp.w * 0.5 - 0.7), 0);
      const by = hf(bx, bz) + 2.02;
      const trav = chamferBox(0.09, 0.09, larg + 0.1, 0.015);
      _e.set(0, cp.yaw, r.range(-0.02, 0.02)); _q.setFromEuler(_e);
      _m.compose(new THREE.Vector3(bx, by, bz), _q, _s);
      this.bat.add(trav, _m, 'metal_pintado', { uvScale: 0.5 });
    }
    // linhas de cal (meio apagadas)
    for (const lz of [-cp.d * 0.5 + 0.5, cp.d * 0.5 - 0.5]) {
      const pts = [];
      for (let i = 0; i <= 8; i++) {
        const lx = lerp(-cp.w * 0.5 + 0.6, cp.w * 0.5 - 0.6, i / 8);
        pts.push(loc(lx, lz));
      }
      const rb = ribbon(pts, 0.11, hf, 0.055);
      this.bat.add(rb.geo, null, 'concreto_liso', { uvScale: 1, castShadow: false });
    }
    const meio = [];
    for (let i = 0; i <= 6; i++) meio.push(loc(0, lerp(-cp.d * 0.5 + 0.5, cp.d * 0.5 - 0.5, i / 6)));
    const rbm = ribbon(meio, 0.11, hf, 0.055);
    this.bat.add(rbm.geo, null, 'concreto_liso', { uvScale: 1, castShadow: false });

    // bola e alguns entulhos na beira
    const [bx2, bz2] = loc(r.range(-4, 4), r.range(-3, 3));
    const bola = new THREE.IcosahedronGeometry(0.11, 1);
    _m.makeRotationY(0); _m.setPosition(bx2, hf(bx2, bz2) + 0.11, bz2);
    this.bat.add(bola.toNonIndexed(), _m, 'plastico', { uvScale: 0.3 });
  }

  /** Kombi, Uno com escada e fusca enferrujados, encostados na rua. */
  veiculos() {
    const r = this.rng.fork('veiculos');
    const rua = this.fav.vias[0];
    const vagas = [];
    for (let i = 8; i < rua.pts.length - 8; i += 7) vagas.push(i);
    r.shuffle(vagas);
    // posiçao/tipo de cada veiculo, publicado para as ferramentas de inspeçao
    // em tools/ conseguirem enquadrar a camera sem adivinhar.
    this.posVeiculos = [];
    const tipos = ['kombi', 'uno', 'fusca', 'kombi', 'carrinho'];
    for (let k = 0; k < Math.min(5, vagas.length); k++) {
      const i = vagas[k];
      const p = rua.pts[i], pn = rua.pts[i + 1];
      let dx = pn[0] - p[0], dz = pn[1] - p[1];
      const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const lado = r.sign();
      const off = rua.w * 0.5 - 0.9;
      const x = p[0] - dz * lado * off, z = p[1] + dx * lado * off;
      const y = this.terrain.heightAt(x, z);
      const yaw = Math.atan2(-dz, dx) + r.range(-0.12, 0.12);
      const tipo = tipos[k % tipos.length];
      this.posVeiculos.push({ tipo, x, y, z, yaw });
      if (tipo === 'kombi') this._kombi(x, y, z, yaw, r);
      else if (tipo === 'uno') this._uno(x, y, z, yaw, r);
      else if (tipo === 'fusca') this._fusca(x, y, z, yaw, r);
      else this._carrinhoMao(x, y, z, yaw, r);
    }
    // um carrinho de mao extra numa praça
    if (this.fav.pracas[0]) {
      const pr = this.fav.pracas[0];
      this._carrinhoMao(pr.x + 1.6, this.terrain.heightAt(pr.x + 1.6, pr.z - 1.2), pr.z - 1.2, r.range(0, 6.28), r);
    }
  }

  _roda(x, y, z, yaw, raio, largura) {
    const g = new THREE.CylinderGeometry(raio, raio, largura, 12);
    // O eixo do cilindro nasce em Y. Tem que virar o Z LOCAL do veiculo (a
    // lateral), nao o X: com rotateZ a roda ficava deitada ao longo do carro e
    // aparecia de perfil como um retangulo escuro. Vale para kombi/fusca/carrinho.
    g.rotateX(Math.PI / 2);
    _m.makeRotationY(yaw); _m.setPosition(x, y, z);
    this.bat.add(g.toNonIndexed(), _m, 'borracha', { uv: 'keep', uvScale: 1.5 });
  }

  _kombi(x, y, z, yaw, r) {
    const put = (g, lx, ly, lz, mat, ry = 0, rz = 0) => {
      _e.set(0, yaw + ry, rz); _q.setFromEuler(_e);
      const c = Math.cos(yaw), s = Math.sin(yaw);
      _m.compose(new THREE.Vector3(x + lx * c + lz * s, y + ly, z - lx * s + lz * c), _q, _s);
      this.bat.add(g, _m, mat, { uvScale: 1 });
    };
    const mat = 'metal_ondulado';
    put(chamferBox(4.2, 1.28, 1.72, 0.05), 0, 1.02, 0, mat);
    put(chamferBox(4.0, 0.62, 1.66, 0.06), -0.05, 1.92, 0, mat);
    put(chamferBox(1.5, 0.5, 1.6, 0.05), 1.5, 0.62, 0, mat);              // bico
    put(chamferBox(0.14, 0.3, 1.72, 0.03), 2.05, 1.05, 0, 'metal_pintado'); // para-choque
    put(chamferBox(0.14, 0.3, 1.72, 0.03), -2.05, 1.05, 0, 'metal_pintado');
    // janelas
    for (const s2 of [-1, 1]) {
      const g = plane(3.3, 0.52, 1, 1, 0);
      _e.set(0, yaw + (s2 > 0 ? 0 : Math.PI) + Math.PI / 2, 0); _q.setFromEuler(_e);
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const lz = s2 * 0.85;
      _m.compose(new THREE.Vector3(x + 0 * c + lz * s, y + 1.9, z - 0 * s + lz * c), _q, _s);
      this.bat.add(g, _m, 'vidro', { uvScale: 1, castShadow: false });
    }
    const c = Math.cos(yaw), s = Math.sin(yaw);
    for (const lx of [1.45, -1.35]) for (const lz of [-0.88, 0.88]) {
      this._roda(x + lx * c + lz * s, y + 0.36, z - lx * s + lz * c, yaw, 0.36, 0.2);
    }
    this.col.addBox(x, y + 1.3, z, 4.3, 2.4, 1.8, yaw, 'metal');
    {
      const lx = -Math.sin(yaw) * 1.7, lz = -Math.cos(yaw) * 1.7;   // lateral do carro
      this.pontosCobertura.push({
        position: new THREE.Vector3(x + lx, y, z + lz),
        normal: new THREE.Vector3(lx, 0, lz).normalize(),
        altura: 1.6, tipo: 'veiculo',
      });
    }
    void r;
  }

  _fusca(x, y, z, yaw, r) {
    const put = (g, lx, ly, lz, mat, rz = 0) => {
      _e.set(0, yaw, rz); _q.setFromEuler(_e);
      const c = Math.cos(yaw), s = Math.sin(yaw);
      _m.compose(new THREE.Vector3(x + lx * c + lz * s, y + ly, z - lx * s + lz * c), _q, _s);
      this.bat.add(g, _m, mat, { uvScale: 1 });
    };
    const mat = r.pick(['metal_ondulado', 'metal_pintado']);
    put(chamferBox(3.6, 0.72, 1.5, 0.09), 0, 0.66, 0, mat);
    put(chamferBox(2.0, 0.62, 1.36, 0.12), -0.1, 1.28, 0, mat);
    put(chamferBox(1.0, 0.42, 1.44, 0.1), 1.4, 0.9, 0, mat);       // capo
    put(chamferBox(1.0, 0.5, 1.44, 0.1), -1.4, 0.95, 0, mat);      // motor
    put(chamferBox(0.12, 0.22, 1.5, 0.03), 1.85, 0.66, 0, 'metal_pintado');
    put(chamferBox(0.12, 0.22, 1.5, 0.03), -1.85, 0.7, 0, 'metal_pintado');
    for (const s2 of [-1, 1]) {
      const g = plane(1.7, 0.44, 1, 1, 0);
      _e.set(0, yaw + Math.PI / 2, 0); _q.setFromEuler(_e);
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const lz = s2 * 0.7;
      _m.compose(new THREE.Vector3(x - 0.1 * c + lz * s, y + 1.32, z + 0.1 * s + lz * c), _q, _s);
      this.bat.add(g, _m, 'vidro', { uvScale: 1, castShadow: false });
    }
    const c = Math.cos(yaw), s = Math.sin(yaw);
    for (const lx of [1.2, -1.2]) for (const lz of [-0.76, 0.76]) {
      this._roda(x + lx * c + lz * s, y + 0.31, z - lx * s + lz * c, yaw, 0.31, 0.18);
    }
    this.col.addBox(x, y + 0.85, z, 3.7, 1.7, 1.55, yaw, 'metal');
    {
      const lx = -Math.sin(yaw) * 1.7, lz = -Math.cos(yaw) * 1.7;   // lateral do carro
      this.pontosCobertura.push({
        position: new THREE.Vector3(x + lx, y, z + lz),
        normal: new THREE.Vector3(lx, 0, lz).normalize(),
        altura: 1.3, tipo: 'veiculo',
      });
    }
  }

  /**
   * Fiat Uno Mille em ruina com a escada de madeira amarrada no teto — a piada
   * brasileira mais conhecida que existe, e o carro certo para uma rua do Rio.
   *
   * Medidas reais aproximadas do Uno Mille (ficha do fabricante, arredondadas
   * ao centimetro): comprimento 3.69 m, largura 1.55 m, altura 1.43 m,
   * entre-eixos 2.36 m. Roda aro 13 com pneu 165/70 R13: raio total ~0.28 m,
   * largura ~0.17 m. Os angulos citados abaixo sao medidos da geometria daqui,
   * escolhidos para bater com a foto de perfil do carro.
   *
   * O que faz reconhecer o Uno e a silhueta de perfil: capo curto e quase plano
   * caindo de leve para a frente, para-brisa muito deitado (~61 graus da
   * vertical), teto plano e comprido, e a traseira quase em pe (~15 graus da
   * vertical) — essa verticalidade e a assinatura do carro. As caixas de roda
   * sao QUADRADAS: nascem do vao entre as caixas da saia inferior, nao de um
   * arco. Ao lado do _fusca (curto, curvo e baixo) tem que parecer outro bicho.
   *
   * Eixos locais: +X frente, +Y cima, +Z o lado que afundou (roda faltando).
   */
  _uno(x, y, z, yaw, r) {
    // ---------------- perfil longitudinal (X local, em metros) ----------------
    const PONTA = 1.845;      // 3.69/2 — face externa do para-choque
    const FACE = 1.685;       // fim da lataria: o para-choque de plastico avanca 16 cm
    const PB_BASE = 0.66;     // base do para-brisa = fim do capo. O Uno e um
                              // cab-forward: so ~1.0 m de capo, a cabine comeca
                              // logo atras da roda dianteira.
    const PB_TOPO = -0.06;    // topo do para-brisa = inicio do teto
    const TETO_FIM = -1.56;   // fim do teto = topo da tampa traseira
    const EIXO_D = 1.15;      // eixo dianteiro
    const EIXO_T = -1.21;     // eixo traseiro  (2.36 m entre-eixos)
    // vaos das caixas de roda: e o buraco entre as caixas da saia que vira o
    // arco quadrado. Folga de 8 cm na frente e atras de cada pneu — apertado o
    // bastante para o vao ler como caixa de roda e nao como pedaco faltando.
    const ARCO_D0 = EIXO_D - 0.36, ARCO_D1 = EIXO_D + 0.36;
    const ARCO_T0 = EIXO_T - 0.36, ARCO_T1 = EIXO_T + 0.36;
    // ------------------------- perfil vertical -------------------------------
    const SAIA = 0.30;        // onde a lataria de porta termina embaixo
    const ARCO = 0.62;        // topo da caixa de roda
    const CINTA = 0.96;       // linha de cintura: base dos vidros. E a MESMA
                              // altura do topo do paralama e do fim do capo: um
                              // carro tem uma linha horizontal so, de ponta a ponta.
    const TETO = 1.43;        // altura total do carro
    // --------------------------- larguras ------------------------------------
    const LARG = 1.55;        // lataria
    const LARG_BAIXO = 1.50;  // saia, levemente recuada em relaçao ao paralama
    const LARG_TETO = 1.28;   // o teto e mais estreito que a cintura
    const BITOLA = 0.68;      // meia-bitola: 1.36 m entre centros de roda
    const RAIO = 0.28, PNEU_L = 0.17;

    // Materiais: corpo enferrujado, porta e tampa traseira de outra cor (carro
    // remendado, detalhe muito comum aqui). Para-choque em 'borracha' porque o
    // Uno tem para-choque de plastico PRETO — e metade da leitura da frente.
    const CORPO = 'metal_ondulado';
    const PAINEL = 'metal_pintado';
    const PLAST = 'borracha';

    // --- matrizes carro->mundo e escada->mundo -------------------------------
    // Alocadas aqui de proposito: isto roda uma vez, na geraçao do mundo, nunca
    // por frame. O carro esta assentado torto (falta a roda traseira do lado +Z
    // e ele deitou nesse canto) — rolagem em torno do eixo do comprimento mais
    // um leve caimento de traseira. Vai tudo na matriz do carro, assim cada
    // peça so precisa da coordenada local.
    const mCarro = new THREE.Matrix4(), mEsc = new THREE.Matrix4();
    const mTmp = new THREE.Matrix4(), mTmp2 = new THREE.Matrix4(), mOut = new THREE.Matrix4();
    const rolagem = 0.085 + r.range(-0.012, 0.012);   // rad (~5 graus) para o lado +Z
    const caimento = 0.022;                            // rad (~1.3 grau), traseira mais baixa
    mCarro.makeRotationY(yaw);
    mTmp.makeRotationX(rolagem); mCarro.multiply(mTmp);
    mTmp.makeRotationZ(caimento); mCarro.multiply(mTmp);
    mCarro.setPosition(x, y - 0.035, z);               // 3.5 cm afundado no asfalto

    /** Peça em espaço do carro. rz inclina no perfil, rx rola, ry gira (porta). */
    const put = (g, lx, ly, lz, mat, rz = 0, rx = 0, ry = 0) => {
      mTmp.makeRotationY(ry);
      mTmp2.makeRotationX(rx); mTmp.multiply(mTmp2);
      mTmp2.makeRotationZ(rz); mTmp.multiply(mTmp2);
      mTmp.setPosition(lx, ly, lz);
      mOut.multiplyMatrices(mCarro, mTmp);
      this.bat.add(g, mOut, mat, { uvScale: 1 });
    };

    // ====================== lataria: a caixa central ==========================
    // Faixa da cintura, inteiriça de ponta a ponta (paralamas + laterais).
    put(chamferBox(FACE * 2, CINTA - ARCO, LARG, 0.035), 0, (ARCO + CINTA) * 0.5, 0, CORPO);
    // Saia inferior em tres pedaços: os dois vaos que sobram SAO as caixas de
    // roda, e por serem retangulares saem quadradas, como no carro de verdade.
    const hSaia = ARCO - SAIA, ySaia = (SAIA + ARCO) * 0.5;
    put(chamferBox(ARCO_D0 - ARCO_T1, hSaia, LARG_BAIXO, 0.03),
      (ARCO_D0 + ARCO_T1) * 0.5, ySaia, 0, CORPO);                       // lateral de porta
    put(chamferBox(FACE - ARCO_D1, hSaia, LARG_BAIXO, 0.03),
      (FACE + ARCO_D1) * 0.5, ySaia, 0, CORPO);                          // avental dianteiro
    put(chamferBox(ARCO_T0 + FACE, hSaia, LARG_BAIXO, 0.03),
      (-FACE + ARCO_T0) * 0.5, ySaia, 0, CORPO);                         // avental traseiro
    // Soleira (rocker) rebaixada e recuada, so entre as rodas: e a chapa mais
    // baixa do carro e o degrau que quebra a lateral chapada.
    put(chamferBox(ARCO_D0 - ARCO_T1, 0.13, LARG - 0.17, 0.02),
      (ARCO_D0 + ARCO_T1) * 0.5, 0.255, 0, CORPO);
    // Friso lateral de plastico preto correndo a lataria inteira: e a marca de
    // carro popular dos anos 90 e o que impede a lateral de virar um caixote.
    put(chamferBox(FACE * 2 - 0.14, 0.06, LARG + 0.03, 0.012), 0, 0.69, 0, PLAST);

    // ====================== capo curto e quase plano ==========================
    // ~1.0 m de capo num carro de 3.69 — curto. Queda de 0.045 rad (2.6 graus)
    // para a frente: quase plano, mas o suficiente para nao parecer mesa.
    // O capo fica ~5 cm ABAIXO da crista do paralama e cai mais 5 cm ate a
    // grade: e essa depressao entre os paralamas que le como capo, e nao como
    // caçamba.
    put(chamferBox(FACE - PB_BASE - 0.02, 0.075, LARG - 0.05, 0.02),
      (FACE + PB_BASE + 0.02) * 0.5, 0.905, 0, CORPO, -0.045);
    // Cowl: o ombro entre o fim do capo e a base do para-brisa. Sem ele fica um
    // buraco na silhueta bem na frente da cabine.
    put(chamferBox(0.52, 0.09, LARG - 0.03, 0.02), 0.46, 0.955, 0, CORPO);

    // ================= para-brisa deitado + teto plano e comprido =============
    // Vai de (0.66, 1.00) a (-0.06, 1.40): 0.72 m de recuo para 0.40 m de subida,
    // ou seja 61 graus da vertical. E o vidro mais deitado do quarteirao.
    const PB_RZ = -0.508;     // atan2(-0.40, 0.72)
    put(chamferBox(0.82, 0.025, 1.24, 0.006), 0.30, 1.20, 0, 'vidro', PB_RZ);
    for (const s2 of [-1, 1]) {   // colunas A, acompanhando o para-brisa
      put(chamferBox(0.85, 0.075, 0.075, 0.012), 0.30, 1.19, s2 * 0.648, CORPO, PB_RZ);
    }
    // teto: 1.28 m de chapa plana — comprido em relaçao ao carro, e o que dá o
    // ar de "tijolinho alto".
    put(chamferBox(PB_TOPO - TETO_FIM, 0.07, LARG_TETO, 0.025),
      (PB_TOPO + TETO_FIM) * 0.5, TETO - 0.035, 0, CORPO);
    for (const s2 of [-1, 1]) {   // canaleta / friso da lateral do teto
      put(chamferBox(PB_TOPO - TETO_FIM, 0.10, 0.075, 0.015),
        (PB_TOPO + TETO_FIM) * 0.5, TETO - 0.06, s2 * 0.655, CORPO);
    }

    // ==================== traseira quase vertical (a assinatura) ==============
    // Tampa de (-1.685, 0.96) a (-1.56, 1.43): 0.125 m de recuo para 0.47 m de
    // subida = 15 graus da vertical. Praticamente em pe.
    const HATCH_RZ = -0.259;
    // tampa em material de painel: porta-malas de outra cor e regra em carro
    // velho de rua, e o contraste ajuda a traseira vertical a se destacar.
    put(chamferBox(0.10, 0.486, 1.34, 0.02), -1.6225, (CINTA + TETO) * 0.5, 0, PAINEL, HATCH_RZ);
    // vidro da tampa, deslocado 5.5 cm na normal da chapa
    put(chamferBox(0.025, 0.27, 1.16, 0.005), -1.654, 1.289, 0, 'vidro', HATCH_RZ);

    // ======================= vidros laterais retos ============================
    // Lado +Z inteiro; lado -Z sem vidro nenhum (arrancado) — e por ali que a
    // porta esta entreaberta.
    // O vidro da porta e um trapezio: a borda da frente acompanha a coluna A.
    // Se fosse retangulo sobraria um triangulo vazado entre o para-brisa e a
    // linha de cintura, e o carro ficava com um buraco na silhueta.
    {
      const tb = new TriBuilder();
      const LZV = 0.655;
      const q = [[0.62, 0.99], [0.02, 1.35], [-0.86, 1.375], [-0.86, 0.99]]
        .map(([px, py]) => [px, py, LZV]);
      tb.quad(q[0], q[1], q[2], q[3], [0, 0, 1]);
      tb.quad(q[3], q[2], q[1], q[0], [0, 0, -1]);   // vidro le dos dois lados
      put(tb.build(), 0, 0, 0, 'vidro');
    }
    put(chamferBox(0.36, 0.42, 0.02, 0.004), -1.10, 1.17, 0.655, 'vidro');   // vigia
    for (const s2 of [-1, 1]) {
      // coluna C larga (22 cm) — outro traço forte do Uno
      put(chamferBox(0.28, TETO - CINTA - 0.005, 0.12, 0.02),
        -1.42, (CINTA + TETO) * 0.5, s2 * 0.62, CORPO);
      // divisao entre o vidro da porta e o vigia
      put(chamferBox(0.06, 0.45, 0.09, 0.012), -0.89, 1.19, s2 * 0.63, CORPO);
    }

    // Miolo da cabine: sem vidro dos dois lados a cabine vira um vao vazado e o
    // carro le como cabine de caminhao. Painel e encosto de banco devolvem massa
    // escura la dentro, que e o que se ve de fora num carro de verdade.
    put(chamferBox(0.34, 0.22, 1.30, 0.03), 0.34, 1.06, 0, PLAST);    // painel
    put(chamferBox(0.13, 0.52, 1.16, 0.03), -0.80, 1.13, 0, PLAST, 0.16);  // encosto do banco

    // ========================== frente e traseira =============================
    // Grade fina entre os farois. O farol do lado +Z esta com o vidro quebrado e
    // mostra o refletor: 'metal_escovado' e claro e destaca a cara do carro do
    // bloco preto do para-choque. O do lado -Z e so o soquete vazio.
    put(chamferBox(0.05, 0.10, 0.84, 0.008), 1.705, 0.84, 0, PLAST);
    put(chamferBox(0.05, 0.13, 0.32, 0.01), 1.705, 0.84, 0.51, 'metal_escovado');
    put(chamferBox(0.05, 0.13, 0.32, 0.01), 1.700, 0.84, -0.51, PLAST);
    // lanternas traseiras: 'pano' e o unico material avermelhado da biblioteca —
    // de longe le como lente vermelha. A do lado +Z esta quebrada.
    put(chamferBox(0.05, 0.24, 0.26, 0.01), -1.705, 0.79, -0.62, 'pano');
    put(chamferBox(0.05, 0.24, 0.26, 0.01), -1.700, 0.79, 0.62, PLAST);
    // para-choques de plastico preto, grandes e destacados da lataria
    put(chamferBox(PONTA - FACE, 0.30, LARG + 0.03, 0.03), (PONTA + FACE) * 0.5, 0.55, 0, PLAST, 0, -0.04);
    // o de tras esta pendurado: torceu 0.12 rad no eixo do comprimento, o que
    // derruba uma ponta ~9 cm, e mais 0.08 rad de caimento no perfil
    put(chamferBox(PONTA - FACE, 0.30, LARG + 0.03, 0.03), -1.75, 0.58, 0, PLAST, 0.08, 0.12);

    // Porta do lado -Z entreaberta: dobradiça na frente, aberta 0.13 rad
    // (7.5 graus). Fica ~4 cm proud da lataria, entao nao ha z-fighting.
    // Vai com a moldura de janela junto: sem ela a chapa le como placa pregada
    // na lateral, e nao como porta.
    const PORTA_A = -0.13, PORTA_HX = 0.60, PORTA_HZ = -0.815;
    const putPorta = (g, offX, ly, mat) => {
      const ca = Math.cos(PORTA_A), sa = Math.sin(PORTA_A);
      put(g, PORTA_HX + offX * ca, ly, PORTA_HZ - offX * sa, mat, 0, 0, PORTA_A);
    };
    putPorta(chamferBox(1.26, CINTA - 0.30, 0.05, 0.02), -0.63, 0.63, PAINEL);
    putPorta(chamferBox(1.14, 0.05, 0.045, 0.008), -0.60, 1.385, PAINEL);   // moldura de cima
    putPorta(chamferBox(0.05, 0.44, 0.045, 0.008), -1.15, 1.18, PAINEL);    // montante de tras
    // retrovisor do lado +Z (o outro ja foi)
    put(chamferBox(0.07, 0.03, 0.07, 0.008), 0.58, 1.02, 0.72, PAINEL);
    put(chamferBox(0.05, 0.11, 0.15, 0.012), 0.56, 1.05, 0.79, PAINEL);

    // ================== rack improvisado + a escada ===========================
    // Duas travessas de cano em cima do teto; a escada apoia nelas, torta.
    for (const lxr of [-0.42, -1.26]) {
      put(chamferBox(0.055, 0.055, 1.36, 0.01), lxr, 1.455, 0, PAINEL);
    }
    // A escada tem 5.5 m num carro de 3.69: sobra 1.6 m para tras e 20 cm para
    // frente. O excesso E a piada, entao ele e deliberadamente grande.
    const ESC_COMP = 5.5, ESC_VAO = 0.44;   // vao entre montantes de escada caseira
    mTmp.makeRotationY(0.10);               // atravessada ~6 graus em relaçao ao carro
    mTmp2.makeRotationX(0.13);              // um montante 6 cm mais alto que o outro
    mEsc.multiplyMatrices(mTmp, mTmp2);
    mTmp.makeRotationZ(0.018);              // ponta de tras caida, a da frente empinada
    mEsc.multiply(mTmp);
    mEsc.setPosition(-0.70, 1.565, 0.05);   // recuada: e o rabo que tem que sobrar
    mEsc.premultiply(mCarro);

    const putE = (g, lx, ly, lz, mat, rx = 0) => {
      mTmp.makeRotationX(rx);
      mTmp.setPosition(lx, ly, lz);
      mOut.multiplyMatrices(mEsc, mTmp);
      this.bat.add(g, mOut, mat, { uvScale: 1 });
    };
    for (const s2 of [-1, 1]) {   // montantes
      putE(chamferBox(ESC_COMP, 0.09, 0.055, 0.01), 0, 0, s2 * ESC_VAO * 0.5, 'madeira');
    }
    // degraus a cada 30 cm (passo de escada de obra). Dois arrancados e um
    // pendurado por um lado so — ela esta tao acabada quanto o carro.
    const nDeg = 18, passo = 0.30;
    const faltando = [r.int(2, 6), r.int(10, 15)];
    const solto = r.int(7, 9);
    for (let i = 0; i < nDeg; i++) {
      if (faltando.includes(i)) continue;
      const lx = -(nDeg - 1) * passo * 0.5 + i * passo;
      putE(chamferBox(0.06, 0.038, ESC_VAO + 0.07, 0.008), lx, 0.012, 0, 'madeira',
        i === solto ? 0.7 : 0);
    }

    // Amarraçao: uma corda escura na travessa da frente e uma tira vermelha na
    // de tras, ambas passando por cima da escada e descendo pela lateral.
    const amarra = (lxa, raio, mat) => {
      const pts = [
        new THREE.Vector3(lxa, 1.30, -0.70), new THREE.Vector3(lxa - 0.02, 1.47, -0.34),
        new THREE.Vector3(lxa, 1.61, 0.02), new THREE.Vector3(lxa + 0.02, 1.47, 0.36),
        new THREE.Vector3(lxa, 1.29, 0.70),
      ];
      this.bat.add(tubeAlong(pts, raio, 3), mCarro, mat, { uvScale: 0.4, castShadow: false });
    };
    amarra(-0.42, 0.014, 'borracha');
    amarra(-1.26, 0.022, 'pano');
    // ponta de corda solta caindo da traseira da escada
    this.bat.add(
      tubeAlong(catenary(new THREE.Vector3(-3.30, 1.42, 0.30), new THREE.Vector3(-2.70, 0.32, 0.58), 0.3, 6), 0.012, 3),
      mCarro, 'borracha', { uvScale: 0.4, castShadow: false });

    // ============================== rodas =====================================
    // Ficam em espaço do MUNDO, no chao: e a lataria que deitou, nao elas.
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const wx = (lx, lz) => x + lx * c + lz * s;
    const wz = (lx, lz) => z - lx * s + lz * c;
    this._roda(wx(EIXO_D, -BITOLA), y + RAIO, wz(EIXO_D, -BITOLA), yaw, RAIO, PNEU_L);
    this._roda(wx(EIXO_D, BITOLA), y + 0.21, wz(EIXO_D, BITOLA), yaw, 0.23, PNEU_L + 0.03); // murcho
    this._roda(wx(EIXO_T, -BITOLA), y + RAIO, wz(EIXO_T, -BITOLA), yaw, RAIO, PNEU_L);
    // a traseira do lado +Z NAO existe: e por isso que o carro esta deitado.

    // a roda que saiu, jogada de lado no chao (deitada: cilindro de eixo Y)
    {
      const rx2 = wx(-1.75, 1.45), rz2 = wz(-1.75, 1.45);
      const g = new THREE.CylinderGeometry(RAIO, RAIO, PNEU_L, 10);
      mOut.makeRotationY(r.range(0, 6.28));
      mOut.setPosition(rx2, this.terrain.heightAt(rx2, rz2) + PNEU_L * 0.5, rz2);
      this.bat.add(g.toNonIndexed(), mOut, 'borracha', { uv: 'keep', uvScale: 1.5 });
    }
    // pilha de tijolo que tentaram enfiar embaixo da soleira e escapou
    for (let i = 0; i < 2; i++) {
      const bx = wx(EIXO_T + r.range(-0.1, 0.1), 0.88), bz = wz(EIXO_T + r.range(-0.1, 0.1), 0.88);
      _e.set(0, yaw + r.range(-0.3, 0.3), 0); _q.setFromEuler(_e);
      _m.compose(new THREE.Vector3(bx, this.terrain.heightAt(bx, bz) + 0.045 + i * 0.09, bz), _q, _s);
      this.bat.pushInstance('tijoloSolto', _m);
    }
    for (let i = 0; i < 3; i++) {   // entulho encostado, oclusao de contato
      const ex = wx(r.range(-2.1, 1.9), r.range(0.85, 1.25)), ez = wz(r.range(-2.1, 1.9), r.range(0.85, 1.25));
      _e.set(r.range(0, 6.28), r.range(0, 6.28), r.range(0, 6.28)); _q.setFromEuler(_e);
      _m.compose(new THREE.Vector3(ex, this.terrain.heightAt(ex, ez) + 0.08, ez), _q, _s);
      this.bat.pushInstance('entulho', _m);
    }

    // ========================= colisao e cobertura ============================
    // Caixa nas medidas reais do Uno (3.69 x 1.43 x 1.55), nao as do fusca.
    // A escada fica a ~1.5 m e nao ganha caixa propria: o teto ja resolve.
    this.col.addBox(x, y + TETO * 0.5, z, 3.69, TETO, LARG, yaw, 'metal');
    {
      // lateral -Z: 0.775 de meia-largura + 0.85 de vao para o soldado caber
      const lx = -Math.sin(yaw) * 1.62, lz = -Math.cos(yaw) * 1.62;
      this.pontosCobertura.push({
        position: new THREE.Vector3(x + lx, y, z + lz),
        normal: new THREE.Vector3(lx, 0, lz).normalize(),
        altura: TETO, tipo: 'veiculo',
      });
    }
  }

  _carrinhoMao(x, y, z, yaw, r) {
    const put = (g, lx, ly, lz, mat, rz = 0) => {
      _e.set(0, yaw, rz); _q.setFromEuler(_e);
      const c = Math.cos(yaw), s = Math.sin(yaw);
      _m.compose(new THREE.Vector3(x + lx * c + lz * s, y + ly, z - lx * s + lz * c), _q, _s);
      this.bat.add(g, _m, mat, { uvScale: 1 });
    };
    put(chamferBox(0.86, 0.32, 0.62, 0.03), 0.1, 0.52, 0, 'metal_ondulado', 0.18);
    for (const s2 of [-1, 1]) put(chamferBox(1.4, 0.045, 0.045, 0.01), -0.5, 0.5, s2 * 0.24, 'madeira');
    const c = Math.cos(yaw), s = Math.sin(yaw);
    this._roda(x + 0.62 * c, y + 0.2, z - 0.62 * s, yaw, 0.2, 0.1);
    for (const s2 of [-1, 1]) put(chamferBox(0.04, 0.3, 0.04, 0.008), 0.2, 0.2, s2 * 0.26, 'metal_pintado');
    void r;
  }

  /** Lixo, galoes, botijoes, caixa de correio, capim entre degraus. */
  entulhoEUrbano() {
    const r = this.rng.fork('urbano');
    const alvo = Math.round(620 * clamp(this.densidade, 0.3, 1));
    let n = 0, tent = 0;
    while (n < alvo && tent++ < alvo * 8) {
      const via = r.pick(this.fav.vias);
      const i = r.int(2, Math.max(3, via.pts.length - 3));
      const p = via.pts[i];
      if (via.escada[i]) continue;
      const lado = r.sign();
      const pn = via.pts[Math.min(via.pts.length - 1, i + 1)];
      let dx = pn[0] - p[0], dz = pn[1] - p[1];
      const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      // encostado na parede/muro: nunca no meio da passagem
      const off = via.w * 0.5 - r.range(0.05, 0.3);
      const x = p[0] - dz * lado * off, z = p[1] + dx * lado * off;
      const y = this.terrain.heightAt(x, z);
      const t = r.weighted(['lixo', 'galao', 'botijao', 'entulho', 'engradado'], [0.4, 0.16, 0.12, 0.22, 0.1]);
      _e.set(0, r.range(0, 6.28), 0); _q.setFromEuler(_e);
      if (t === 'lixo') {
        const pilha = r.int(1, 3);
        for (let k = 0; k < pilha; k++) {
          _e.set(r.range(-0.3, 0.3), r.range(0, 6.28), r.range(-0.3, 0.3)); _q.setFromEuler(_e);
          const esc = r.range(0.7, 1.15);
          _m.compose(new THREE.Vector3(x + r.range(-0.3, 0.3), y + 0.02, z + r.range(-0.3, 0.3)), _q,
            new THREE.Vector3(esc, esc, esc));
          this.bat.pushInstance('sacoLixo', _m);
        }
      } else if (t === 'galao') {
        _m.compose(new THREE.Vector3(x, y + 0.31, z), _q, _s);
        this.bat.pushInstance('galao', _m, AZUL_GALAO);
      } else if (t === 'botijao') {
        _m.compose(new THREE.Vector3(x, y + 0.26, z), _q, _s);
        this.bat.pushInstance('botijao', _m);
      } else if (t === 'entulho') {
        const pilha = r.int(1, 4);
        for (let k = 0; k < pilha; k++) {
          _e.set(r.range(0, 6.28), r.range(0, 6.28), r.range(0, 6.28)); _q.setFromEuler(_e);
          _m.compose(new THREE.Vector3(x + r.range(-0.35, 0.35), y + 0.1, z + r.range(-0.35, 0.35)), _q, _s);
          this.bat.pushInstance('entulho', _m);
        }
      } else {
        _m.compose(new THREE.Vector3(x, y + 0.14, z), _q, _s);
        this.bat.pushInstance('engradado', _m);
      }
      n++;
    }

    // caixas de correio na rua principal
    const rua = this.fav.vias[0];
    for (let k = 0; k < 4; k++) {
      const i = 10 + k * Math.floor((rua.pts.length - 20) / 4);
      const p = rua.pts[i];
      const lado = r.sign();
      const pn = rua.pts[i + 1];
      let dx = pn[0] - p[0], dz = pn[1] - p[1];
      const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const off = rua.w * 0.5 + 1.1;
      const x = p[0] - dz * lado * off, z = p[1] + dx * lado * off;
      const y = this.terrain.heightAt(x, z);
      const yaw = Math.atan2(-dz, dx);
      const poste = chamferBox(0.07, 1.05, 0.07, 0.012);
      _m.makeRotationY(yaw); _m.setPosition(x, y + 0.52, z);
      this.bat.add(poste, _m, 'metal_pintado', { uvScale: 0.4 });
      const caixa = chamferBox(0.42, 0.3, 0.26, 0.02);
      _m.makeRotationY(yaw); _m.setPosition(x, y + 1.16, z);
      this.bat.add(caixa, _m, 'metal_pintado', { uvScale: 0.4 });
    }
  }

  /** Lonas e telhas cobrindo trechos de beco: os corredores cobertos. */
  coberturas() {
    const r = this.rng.fork('coberturas');
    for (const via of this.fav.vias) {
      if (via.tipo !== 'beco' || via.pts.length < 12) continue;
      if (!r.chance(0.42)) continue;
      const i0 = r.int(2, via.pts.length - 8);
      const nSeg = r.int(4, 9);
      const i1 = Math.min(via.pts.length - 2, i0 + nSeg);
      const matC = r.chance(0.55) ? 'telha_fibrocimento' : 'metal_ondulado';
      for (let i = i0; i < i1; i++) {
        const p = via.pts[i], pn = via.pts[i + 1];
        const dx = pn[0] - p[0], dz = pn[1] - p[1];
        const seg = Math.hypot(dx, dz) || 1;
        const yaw = Math.atan2(-dz, dx);
        const y = this.terrain.heightAt(p[0], p[1]) + r.range(2.35, 2.9);
        const g = corrugatedSheet(seg * 1.15, via.w + 0.9, 0.025, 0.16, 0.03);
        g.rotateZ(r.range(-0.05, 0.05));
        _m.makeRotationY(yaw); _m.setPosition((p[0] + pn[0]) * 0.5, y, (p[1] + pn[1]) * 0.5);
        this.bat.add(g, _m, matC, { uvScale: 1 });
        via.coberto[i] = true;
        // caibro de madeira atravessado
        if (i % 2 === 0) {
          const c = chamferBox(0.07, 0.09, via.w + 0.9, 0.012);
          _m.makeRotationY(yaw); _m.setPosition(p[0], y - 0.09, p[1]);
          this.bat.add(c, _m, 'madeira', { uvScale: 0.6 });
        }
      }
    }
  }
}

// ------------------------------------------------------------------ helpers

/** Desloca lateralmente uma polilinha 2D. */
function deslocar(pts, off) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0], dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    out.push([pts[i][0] - dz * off, pts[i][1] + dx * off]);
  }
  return out;
}

/** Faixa vertical (meio-fio) ao longo de uma polilinha. */
function faixaVertical(pts, hf, y0, y1) {
  const b = new TriBuilder();
  const baixo = [], alto = [];
  for (const p of pts) {
    const h = hf(p[0], p[1]);
    baixo.push([p[0], h + y0, p[1]]);
    alto.push([p[0], h + y1, p[1]]);
  }
  b.strip(baixo, alto, null);
  return b.build();
}

/** Trechos contiguos de uma via que NAO sao escada. */
function trechosNaoEscada(via) {
  const out = [];
  let ini = 0;
  for (let i = 0; i < via.escada.length; i++) {
    if (via.escada[i]) {
      if (i - ini >= 2) out.push([ini, i]);
      ini = i + 1;
    }
  }
  if (via.escada.length - ini >= 2) out.push([ini, via.escada.length - 1]);
  return out;
}

/** Reamostra uma polilinha a passo constante. */
function reamostrar(pts, passo) {
  const out = [pts[0].slice()];
  let resto = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let t = resto;
    while (t < seg) {
      const k = t / seg;
      out.push([lerp(a[0], b[0], k), lerp(a[1], b[1], k)]);
      t += passo;
    }
    resto = t - seg;
  }
  return out;
}

/** Disco colado ao terreno (praça). */
function discoGeo(cx, cz, r, hf, yOff, seg) {
  const b = new TriBuilder();
  const anel = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    anel.push([x, hf(x, z) + yOff, z]);
  }
  b.fan([cx, hf(cx, cz) + yOff, cz], anel, [0, 1, 0]);
  return b.build();
}

/** Retangulo orientado colado ao terreno, subdividido. */
function retanguloColado(cx, cz, w, d, yaw, hf, yOff, nu, nv) {
  const b = new TriBuilder();
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const pt = (i, j) => {
    const lx = (i / nu - 0.5) * w, lz = (j / nv - 0.5) * d;
    const x = cx + lx * c + lz * s, z = cz - lx * s + lz * c;
    return [x, hf(x, z) + yOff, z];
  };
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++)
    b.quad(pt(i, j), pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1), [0, 1, 0]);
  return b.build();
}

export { deslocar, reamostrar };
