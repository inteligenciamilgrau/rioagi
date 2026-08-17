/**
 * Pickups — itens coletáveis: munição, kit médico e caixa de suprimento.
 *
 * Duas fontes:
 *   · drop de inimigo morto (sempre munição, às vezes kit)
 *   · itens fixos dentro das casas com interior, colocados no boot
 *
 * Coleta é automática por proximidade, como em FPS moderno — parar para apertar
 * tecla em cima de munição quebra o ritmo do tiroteio. Mas um item que NÃO
 * serve (kit com vida cheia) é ignorado em vez de desperdiçado: o jogador volta
 * nele depois.
 *
 * Geometria e materiais são procedurais e COMPARTILHADOS entre todas as
 * instâncias; o pool nunca aloca em runtime.
 */
import * as THREE from 'three';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/** Distância de coleta (m). Generosa: o jogador não deve ter de mirar no chão. */
const RAIO_COLETA = 1.35;
/** Teto de itens simultâneos. Acima disso o mais velho some. */
const MAX_ITENS = 48;
/** Segundos até um drop de inimigo evaporar (itens de casa não expiram). */
const VIDA_DROP = 75;

export const TIPO = {
  MUNICAO: 'municao',
  KIT: 'kit',
  SUPRIMENTO: 'suprimento',
};

const DEF = {
  [TIPO.MUNICAO]: {
    rotulo: 'MUNIÇÃO', cor: 0x6f7a4a, corLuz: 0xc4d17a,
    municao: 0.45,          // fração da reserva máxima devolvida
    vida: 0,
    som: 'municao',
  },
  [TIPO.KIT]: {
    rotulo: 'KIT MÉDICO', cor: 0xe8e2d6, corLuz: 0xff5b52,
    municao: 0,
    vida: 45,
    som: 'kit',
  },
  [TIPO.SUPRIMENTO]: {
    rotulo: 'SUPRIMENTO', cor: 0x4a5560, corLuz: 0xe8873c,
    municao: 1.0,
    vida: 30,
    som: 'suprimento',
  },
};

/* ------------------------------------------------------------------------ */
/* Geometria procedural                                                      */
/* ------------------------------------------------------------------------ */

/** Caixote de munição: corpo chanfrado + cintas + alça. */
function geoMunicao() {
  const partes = [];
  const corpo = new THREE.BoxGeometry(0.34, 0.19, 0.22);
  partes.push(corpo);
  for (const x of [-0.10, 0.10]) {
    const cinta = new THREE.BoxGeometry(0.035, 0.205, 0.235);
    cinta.translate(x, 0, 0);
    partes.push(cinta);
  }
  const alca = new THREE.TorusGeometry(0.045, 0.011, 6, 12, Math.PI);
  alca.rotateX(Math.PI / 2);
  alca.translate(0, 0.10, 0);
  partes.push(alca);
  return fundir(partes);
}

/** Kit médico: caixa clara com cruz em relevo. */
function geoKit() {
  const partes = [];
  partes.push(new THREE.BoxGeometry(0.30, 0.16, 0.20));
  const b1 = new THREE.BoxGeometry(0.15, 0.02, 0.045); b1.translate(0, 0.085, 0);
  const b2 = new THREE.BoxGeometry(0.045, 0.02, 0.12); b2.translate(0, 0.085, 0);
  partes.push(b1, b2);
  const trava = new THREE.BoxGeometry(0.05, 0.03, 0.21); trava.translate(0, 0.02, 0);
  partes.push(trava);
  return fundir(partes);
}

/** Suprimento: engradado maior com ripas. */
function geoSuprimento() {
  const partes = [];
  partes.push(new THREE.BoxGeometry(0.42, 0.30, 0.30));
  for (const y of [-0.09, 0.09]) {
    const r = new THREE.BoxGeometry(0.435, 0.035, 0.315); r.translate(0, y, 0);
    partes.push(r);
  }
  return fundir(partes);
}

/** Une geometrias não-indexadas num único BufferGeometry (sem BufferGeometryUtils). */
function fundir(lista) {
  let total = 0;
  const arrs = lista.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    if (n !== g) g.dispose();
    total += n.attributes.position.count;
    return n;
  });
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let o = 0;
  for (const g of arrs) {
    const c = g.attributes.position.count;
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
    o += c;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
}

/* ------------------------------------------------------------------------ */

export class Pickups {
  constructor(ctx) {
    this.ctx = ctx;
    this.grupo = new THREE.Group();
    this.grupo.name = 'itens';
    this.itens = [];
    this._offs = [];
    this._t = 0;
    this.pausable = true;
  }

  async init() {
    const ctx = this.ctx;

    // --- recursos compartilhados ---
    this.geo = {
      [TIPO.MUNICAO]: geoMunicao(),
      [TIPO.KIT]: geoKit(),
      [TIPO.SUPRIMENTO]: geoSuprimento(),
    };
    this.mat = {};
    for (const [tipo, d] of Object.entries(DEF)) {
      this.mat[tipo] = new THREE.MeshStandardMaterial({
        color: d.cor, roughness: 0.62, metalness: 0.12,
        emissive: new THREE.Color(d.corLuz), emissiveIntensity: 0.22,
        name: `item_${tipo}`,
      });
    }

    // --- pool ---
    for (let i = 0; i < MAX_ITENS; i++) {
      const m = new THREE.Mesh(this.geo[TIPO.MUNICAO], this.mat[TIPO.MUNICAO]);
      m.castShadow = true;
      m.receiveShadow = false;
      m.visible = false;
      m.matrixAutoUpdate = true;
      this.grupo.add(m);
      this.itens.push({
        mesh: m, tipo: null, ativo: false, fixo: false,
        base: new THREE.Vector3(), fase: 0, idade: 0,
      });
    }

    ctx.scene.add(this.grupo);
    this._ligarEventos();
    this._povoarCasas();
    return this;
  }

  /* ------------------------------------------------------------------ */

  _ligarEventos() {
    const bus = this.ctx.bus;
    if (!bus) return;
    const on = (n, f) => this._offs.push(bus.on(n, f));

    on('enemy:killed', (p) => {
      if (!p?.point) return;
      _v.copy(p.point);
      // Munição quase sempre; kit só de vez em quando, senão o jogador nunca
      // fica sob pressão de recurso.
      this.soltar(TIPO.MUNICAO, _v);
      if (Math.random() < 0.28) {
        _v2.copy(_v);
        _v2.x += (Math.random() - 0.5) * 0.7;
        _v2.z += (Math.random() - 0.5) * 0.7;
        this.soltar(TIPO.KIT, _v2);
      }
    });

    on('game:start', () => this.reset());
  }

  /** Coloca itens fixos dentro das casas que têm interior. */
  _povoarCasas() {
    const casas = this.ctx.world?.favela?.casas ?? [];
    const col = this.ctx.world?.collision;
    let postos = 0;
    const alvo = Math.min(14, Math.floor(casas.length * 0.06));

    for (const casa of casas) {
      if (postos >= alvo) break;
      if (!casa.interior) continue;
      if (Math.random() < 0.45) continue;

      // ponto aleatório no miolo da casa, recuado das paredes
      const lx = (Math.random() - 0.5) * Math.max(0.4, casa.w - 1.6);
      const lz = (Math.random() - 0.5) * Math.max(0.4, casa.d - 1.6);
      const c = Math.cos(casa.yaw), s = Math.sin(casa.yaw);
      const x = casa.x + lx * c + lz * s;
      const z = casa.z - lx * s + lz * c;

      // apoia no piso de verdade em vez de confiar em baseY
      let y = casa.baseY + 0.1;
      if (col?.raycast) {
        _v.set(x, casa.baseY + 2.4, z);
        _v2.set(0, -1, 0);
        const h = col.raycast(_v, _v2, 5);
        if (h?.hit) y = h.point.y;
      }

      const tipo = Math.random() < 0.22 ? TIPO.SUPRIMENTO
        : (Math.random() < 0.5 ? TIPO.KIT : TIPO.MUNICAO);
      _v.set(x, y, z);
      if (this.soltar(tipo, _v, true)) postos++;
    }
    console.info(`[Itens] ${postos} item(ns) fixo(s) posicionados em casas`);
  }

  /**
   * @param {string} tipo TIPO.*
   * @param {THREE.Vector3} pos ponto no chão
   * @param {boolean} fixo item de cenário (não expira)
   */
  soltar(tipo, pos, fixo = false) {
    const d = DEF[tipo];
    if (!d) return null;

    let slot = this.itens.find((i) => !i.ativo);
    if (!slot) {
      // recicla o drop mais velho; itens fixos são preservados
      slot = this.itens.filter((i) => !i.fixo).sort((a, b) => b.idade - a.idade)[0];
      if (!slot) return null;
    }

    slot.tipo = tipo;
    slot.ativo = true;
    slot.fixo = fixo;
    slot.idade = 0;
    slot.fase = Math.random() * Math.PI * 2;
    slot.base.copy(pos);
    slot.base.y += 0.13;              // meio caixote acima do chão

    slot.mesh.geometry = this.geo[tipo];
    slot.mesh.material = this.mat[tipo];
    slot.mesh.position.copy(slot.base);
    slot.mesh.rotation.set(0, Math.random() * Math.PI * 2, 0);
    slot.mesh.visible = true;
    return slot;
  }

  /* ------------------------------------------------------------------ */

  update(dt) {
    this._t += dt;
    const jog = this.ctx.player;
    const podeColetar = jog && jog.alive !== false && this.ctx.state === 'jogando';

    for (const it of this.itens) {
      if (!it.ativo) continue;

      // flutuação + giro lento: é o que faz o item ser notado no chão escuro
      const b = Math.sin(this._t * 1.9 + it.fase) * 0.045;
      it.mesh.position.set(it.base.x, it.base.y + b, it.base.z);
      it.mesh.rotation.y += dt * 0.85;

      if (!it.fixo) {
        it.idade += dt;
        if (it.idade > VIDA_DROP) { this._recolher(it); continue; }
        // pisca antes de sumir, para o jogador ter aviso
        const resta = VIDA_DROP - it.idade;
        if (resta < 6) it.mesh.visible = (Math.sin(resta * 12) > -0.35);
      }

      if (!podeColetar) continue;
      _v.copy(it.base).sub(jog.position);
      _v.y *= 0.55;                    // tolerância vertical maior (degraus)
      if (_v.lengthSq() > RAIO_COLETA * RAIO_COLETA) continue;
      this._tentarColetar(it);
    }
  }

  /** Só consome o item se ele realmente servir para alguma coisa agora. */
  _tentarColetar(it) {
    const d = DEF[it.tipo];
    const jog = this.ctx.player;
    let usou = false;
    const partes = [];

    if (d.municao > 0) {
      const ganho = this._darMunicao(d.municao);
      if (ganho > 0) { usou = true; partes.push(`+${ganho} MUN`); }
    }

    if (d.vida > 0 && jog.health < jog.maxHealth) {
      const antes = jog.health;
      jog.health = Math.min(jog.maxHealth, jog.health + d.vida);
      const ganho = Math.round(jog.health - antes);
      this.ctx.bus?.emit('player:health', { health: jog.health, max: jog.maxHealth });
      if (ganho > 0) { usou = true; partes.push(`+${ganho} VIDA`); }
    }

    if (!usou) return;   // nada a ganhar: deixa no chão para depois

    this._recolher(it);
    this.ctx.hud?.aviso?.(`${d.rotulo}  ${partes.join('  ')}`, 1200);
    this.ctx.bus?.emit('item:coletado', { tipo: it.tipo, rotulo: d.rotulo });
    this.ctx.audio?.recarga?.('magin');   // clique mecânico curto já existente
  }

  /**
   * Devolve munição de reserva proporcional ao máximo de cada arma.
   * @returns {number} total efetivamente adicionado
   */
  _darMunicao(fracao) {
    const ws = this.ctx.player?.weapons;
    const slots = ws?.slots ?? [];
    let total = 0;
    for (const s of slots) {
      const max = s.def?.reserveAmmo ?? 0;
      if (!max || s.reserve >= max) continue;
      const add = Math.min(max - s.reserve, Math.ceil(max * fracao));
      s.reserve += add;
      total += add;
    }
    if (total > 0) ws?._emitState?.(true);
    return total;
  }

  _recolher(it) {
    it.ativo = false;
    it.fixo = false;
    it.tipo = null;
    it.mesh.visible = false;
  }

  /** Limpa drops, mantém os itens de casa. */
  reset() {
    for (const it of this.itens) if (it.ativo && !it.fixo) this._recolher(it);
  }

  estatisticas() {
    return {
      ativos: this.itens.filter((i) => i.ativo).length,
      fixos: this.itens.filter((i) => i.ativo && i.fixo).length,
    };
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
    for (const g of Object.values(this.geo)) g.dispose();
    for (const m of Object.values(this.mat)) m.dispose();
    this.ctx.scene?.remove(this.grupo);
  }
}

export default Pickups;
