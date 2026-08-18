/**
 * MapaGrande — mapa 2D em tela cheia, aberto segurando TAB.
 *
 * ## Por que existe separado do Minimap
 * O minimapa gira com o jogador e mostra 58 m ao redor: serve para reagir, nao
 * para se localizar. Quem quer entender ONDE esta no morro — ou contar para
 * outra pessoa onde ficou preso — precisa do mapa inteiro, parado, com o norte
 * para cima. Sao duas leituras diferentes do mesmo dado.
 *
 * Reaproveita o bitmap que o Minimap ja rasterizou do `navGrid` (`.base`): esse
 * canvas offscreen custa caro para montar e nao muda, entao rasterizar de novo
 * aqui seria desperdicio pelo mesmo resultado.
 *
 * ## O que aparece e o que NAO aparece
 * Hostil so entra se o jogador PODE VE-LO: dentro do campo de visao horizontal
 * e com linha de visada livre. O mapa nao e raio-x — mostrar inimigo atras de
 * parede transformaria o TAB em trapaca e tiraria o valor do som e da cautela.
 */

const _origem = { x: 0, y: 0, z: 0 };
const _dir = { x: 0, y: 0, z: 0 };

/** Meia-abertura horizontal considerada "campo de visao", em radianos. */
const MEIO_FOV = 0.62;          // ~71 graus no total, o mesmo cone do minimapa
/** Alcance maximo para checar visibilidade (m). Alem disso nao se identifica. */
const ALCANCE_VISTA = 90;

export class MapaGrande {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} ctx GameContext
   * @param {object} minimap fonte do bitmap ja rasterizado do navGrid
   */
  constructor(canvas, ctx, minimap) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.minimap = minimap;
    this.g = canvas.getContext('2d');
    this.aberto = false;
    this.hostisVistos = 0;
    this._hostis = [];
  }

  /** Ajusta o backing store ao tamanho em CSS pixels. */
  _resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(64, Math.round((r.width || 640) * dpr));
    const h = Math.max(64, Math.round((r.height || 480) * dpr));
    if (w === this.canvas.width && h === this.canvas.height) return;
    this.canvas.width = w;
    this.canvas.height = h;
  }

  /**
   * Hostis que o jogador realmente enxerga.
   *
   * Duas condicoes, NESTA ordem porque a segunda e cara: primeiro o angulo
   * (comparacao trivial), depois o raycast de linha de visada. Inverter isso
   * pagaria BVH para inimigo que esta atras da nuca.
   */
  _hostisVisiveis(out) {
    out.length = 0;
    const ctx = this.ctx;
    const ai = ctx?.ai;
    const jog = ctx?.player;
    if (!ai || !jog?.eyePosition) return out;

    const lista = (typeof ai.getEnemies === 'function' ? ai.getEnemies() : null)
      ?? ai.enemies ?? ai.inimigos ?? ai.pool;
    if (!lista?.length) return out;

    const olho = jog.eyePosition;
    const yaw = jog.rig?.yaw ?? 0;
    // Convencao medida (tools/yaw.mjs): direcao(yaw) = (-sin, 0, -cos).
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const cosLimite = Math.cos(MEIO_FOV);
    const col = ctx.world?.collision;

    for (const e of lista) {
      if (!e || e.ativo === false) continue;
      if (e.morto || e.alive === false || e.vivo === false) continue;
      const p = e.pos ?? e.position ?? e.posicao;
      if (!p) continue;

      let dx = p.x - olho.x;
      let dz = p.z - olho.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.01 || dist > ALCANCE_VISTA) continue;
      dx /= dist; dz /= dist;

      // dentro do cone?
      if (dx * fx + dz * fz < cosLimite) continue;

      // linha de visada livre? (mira no peito, nao nos pes)
      if (col?.raycast) {
        _origem.x = olho.x; _origem.y = olho.y; _origem.z = olho.z;
        const alvoY = (p.y ?? olho.y) + 1.1;
        _dir.x = p.x - olho.x;
        _dir.y = alvoY - olho.y;
        _dir.z = p.z - olho.z;
        const comp = Math.hypot(_dir.x, _dir.y, _dir.z) || 1;
        _dir.x /= comp; _dir.y /= comp; _dir.z /= comp;
        // Encurtamos 40 cm para o raio nao bater no proprio corpo do alvo.
        const r = col.raycast(_origem, _dir, comp - 0.4);
        if (r?.hit) continue;
      }

      out.push({ x: p.x, z: p.z, atirando: !!(e.atirando || e.firing) });
    }
    return out;
  }

  /** Desenha. So e chamado com o mapa aberto. */
  update() {
    const g = this.g;
    if (!g) return;
    this._resize();
    const W = this.canvas.width;
    const H = this.canvas.height;

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);

    const mm = this.minimap;
    const ng = mm?.grid;
    const base = mm?.base;
    if (!base || !ng) return;

    /* O mapa inteiro cabe na tela, NORTE PARA CIMA. Nada de girar: mapa que
     * gira serve para reagir (e o minimapa ja faz isso); este serve para se
     * localizar, e para isso o norte tem de ficar parado. */
    const margem = Math.round(Math.min(W, H) * 0.06);
    const esc = Math.min((W - margem * 2) / base.width, (H - margem * 2) / base.height);
    const larg = base.width * esc;
    const alt = base.height * esc;
    const ox = (W - larg) / 2;
    const oy = (H - alt) / 2;

    g.save();
    g.imageSmoothingEnabled = true;
    g.globalAlpha = 0.92;
    g.drawImage(base, ox, oy, larg, alt);
    g.restore();

    g.strokeStyle = 'rgba(233,229,219,.18)';
    g.lineWidth = Math.max(1, esc * 0.6);
    g.strokeRect(ox, oy, larg, alt);

    const cs = ng.cellSize ?? 0.5;
    const gx = ng.origin?.x ?? 0;
    const gz = ng.origin?.z ?? 0;
    const telaX = (wx) => ox + ((wx - gx) / cs) * esc;
    const telaY = (wz) => oy + ((wz - gz) / cs) * esc;

    const jog = this.ctx?.player;
    const p = jog?.position;
    if (!p) return;
    const yaw = jog.rig?.yaw ?? 0;
    const euX = telaX(p.x);
    const euY = telaY(p.z);

    /* ---------- cone de visao ---------- */
    const raio = Math.max(28, Math.min(W, H) * 0.16);
    g.save();
    g.translate(euX, euY);
    g.rotate(yaw);
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, raio);
    grad.addColorStop(0, 'rgba(232,135,60,.34)');
    grad.addColorStop(1, 'rgba(232,135,60,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, 0);
    g.arc(0, 0, raio, -Math.PI / 2 - MEIO_FOV, -Math.PI / 2 + MEIO_FOV);
    g.closePath();
    g.fill();
    g.restore();

    /* ---------- hostis vistos ---------- */
    const hostis = this._hostisVisiveis(this._hostis);
    const rBase = Math.max(3, Math.min(W, H) * 0.006);
    for (const h of hostis) {
      const hx = telaX(h.x);
      const hy = telaY(h.z);
      g.beginPath();
      g.arc(hx, hy, rBase * (h.atirando ? 1.5 : 1), 0, Math.PI * 2);
      g.fillStyle = h.atirando ? '#ff7b52' : '#e0443a';
      g.fill();
      g.lineWidth = Math.max(1, rBase * 0.4);
      g.strokeStyle = 'rgba(10,11,13,.8)';
      g.stroke();
    }
    this.hostisVistos = hostis.length;

    /* ---------- jogador ---------- */
    g.save();
    g.translate(euX, euY);
    g.rotate(yaw);
    const s = Math.max(5, Math.min(W, H) * 0.009);
    g.beginPath();
    g.moveTo(0, -s * 1.5);
    g.lineTo(s, s);
    g.lineTo(0, s * 0.45);
    g.lineTo(-s, s);
    g.closePath();
    g.fillStyle = '#e9e5db';
    g.strokeStyle = 'rgba(10,11,13,.85)';
    g.lineWidth = Math.max(1, s * 0.28);
    g.fill();
    g.stroke();
    g.restore();

    /* ---------- rosa dos ventos ---------- */
    const fonte = Math.max(11, Math.round(Math.min(W, H) * 0.022));
    g.font = '700 ' + fonte + 'px ui-monospace, monospace';
    g.fillStyle = 'rgba(233,229,219,.55)';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('N', ox + larg / 2, oy - margem * 0.45);
    g.fillText('S', ox + larg / 2, oy + alt + margem * 0.45);
    g.textAlign = 'left';
    g.fillText('O', ox - margem * 0.75, oy + alt / 2);
    g.fillText('L', ox + larg + margem * 0.3, oy + alt / 2);
  }
}
