/**
 * Minimap — canto superior esquerdo.
 * Dono: agente UI.
 *
 * Estratégia: o `world.navGrid` é rasterizado UMA vez num canvas offscreen
 * (é literalmente uma projeção ortográfica de cima — andável x bloqueado, com
 * sombreamento de relevo tirado do `heightData`). Por frame só recortamos,
 * giramos e desenhamos esse bitmap: um `drawImage` e meia dúzia de vetores.
 * Nada de renderizar a cena de novo numa segunda câmera.
 *
 * O mapa gira com o jogador (proa sempre para cima), como no CoD.
 */

const METROS_VISIVEIS = 58;   // largura do recorte visível, em metros
const MAX_BLIPS = 24;

export class Minimap {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} ctx GameContext (pode estar incompleto)
   */
  constructor(canvas, ctx) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.g = canvas.getContext('2d', { alpha: false });
    this.base = null;          // canvas offscreen com o navGrid rasterizado
    this.grid = null;
    this.dpr = 1;
    this._blips = [];          // preenchido por setBlips() (usado pelo mock)
    this._blipsExternos = false;
    this._lado = 0;
    this._tmp = { x: 0, z: 0 };
    this._resize();
  }

  /** Ajusta o backing store ao tamanho em CSS pixels. */
  _resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const lado = Math.max(64, Math.round((r.width || 150) * dpr));
    if (lado === this._lado && dpr === this.dpr) return false;
    this._lado = lado;
    this.dpr = dpr;
    this.canvas.width = lado;
    this.canvas.height = lado;
    return true;
  }

  /** Rasteriza o navGrid. Chamado no init e quando o mundo muda. */
  construir(navGrid = null) {
    const ng = navGrid ?? this.ctx?.world?.navGrid ?? null;
    if (!ng || !ng.data || !ng.width) { this.grid = null; this.base = null; return false; }
    this.grid = ng;

    const w = ng.width, h = ng.height;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d');
    const img = g.createImageData(w, h);
    const px = img.data;
    const hd = ng.heightData || null;

    // Relevo: luz rasante vinda do noroeste, igual ao entardecer do jogo.
    const LX = -0.62, LZ = -0.78;

    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        const andavel = ng.data[k] === 1;

        // Borda: célula andável colada em bloqueio vira contorno claro (calçada).
        let borda = false;
        if (andavel) {
          for (let d = 0; d < 4 && !borda; d++) {
            const ni = i + (d === 0 ? 1 : d === 1 ? -1 : 0);
            const nj = j + (d === 2 ? 1 : d === 3 ? -1 : 0);
            if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
            if (ng.data[nj * w + ni] === 0) borda = true;
          }
        }

        let r, gg, b;
        if (andavel) { r = borda ? 0x46 : 0x33; gg = borda ? 0x4e : 0x3a; b = borda ? 0x58 : 0x43; }
        else { r = 0x0f; gg = 0x11; b = 0x15; }

        // Sombreamento de encosta (só onde há dados de altura).
        if (hd) {
          const hx = (hd[k + (i < w - 1 ? 1 : 0)] - hd[k - (i > 0 ? 1 : 0)]) * 0.5;
          const hz = (hd[k + (j < h - 1 ? w : 0)] - hd[k - (j > 0 ? w : 0)]) * 0.5;
          const lum = 1 + Math.max(-0.55, Math.min(0.55, -(hx * LX + hz * LZ) * 1.7));
          r = Math.min(255, r * lum); gg = Math.min(255, gg * lum); b = Math.min(255, b * lum);
        }

        const o = k * 4;
        px[o] = r; px[o + 1] = gg; px[o + 2] = b; px[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    this.base = cv;
    return true;
  }

  /** Blips manuais: `[{x, z, tipo}]` com tipo 'hostil' | 'objetivo' | 'aliado'. */
  setBlips(lista) {
    this._blips = lista || [];
    this._blipsExternos = !!lista;
  }

  /** Lê os inimigos do AIManager de forma defensiva (o contrato ainda é aberto). */
  _coletarBlips(out) {
    out.length = 0;
    if (this._blipsExternos) {
      for (let i = 0; i < this._blips.length && out.length < MAX_BLIPS; i++) out.push(this._blips[i]);
      return out;
    }
    const ai = this.ctx?.ai;
    if (!ai) return out;
    const lista = (typeof ai.getEnemies === 'function' ? ai.getEnemies() : null) ?? ai.enemies ?? ai.inimigos;
    if (!lista || !lista.length) return out;
    for (let i = 0; i < lista.length && out.length < MAX_BLIPS; i++) {
      const e = lista[i];
      const p = e?.position ?? e?.posicao;
      if (!p) continue;
      if (e.alive === false || e.vivo === false || e.state === 'MORTO' || e.dead) continue;
      // Só entra no radar quem já foi percebido — se a IA não expõe isso,
      // mostramos todos (melhor um radar cheio do que um radar quebrado).
      const visto = e.detected ?? e.visivel ?? e.visible ?? e.aware ?? e.alerta ?? null;
      if (visto === false) continue;
      out.push({ x: p.x, z: p.z, tipo: 'hostil', firing: !!(e.firing || e.atirando) });
    }
    return out;
  }

  /**
   * @param {number} px posição X do jogador (mundo)
   * @param {number} pz posição Z do jogador (mundo)
   * @param {number} rumoRad rumo da câmera em radianos (0 = norte, horário)
   */
  update(px, pz, rumoRad) {
    const g = this.g;
    if (!g) return;
    this._resize();
    const S = this._lado;
    const meio = S / 2;

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#0a0c0e';
    g.fillRect(0, 0, S, S);

    const ng = this.grid;
    const cs = ng?.cellSize ?? 0.5;
    const escala = S / (METROS_VISIVEIS / cs);   // pixels de tela por célula

    if (this.base && ng) {
      const ox = ng.origin?.x ?? 0;
      const oz = ng.origin?.z ?? 0;
      const cx = (px - ox) / cs;   // célula fracionária do jogador
      const cz = (pz - oz) / cs;

      g.save();
      g.translate(meio, meio);
      g.rotate(-rumoRad);
      g.scale(escala, escala);
      g.translate(-cx, -cz);
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'low';
      g.drawImage(this.base, 0, 0);
      g.restore();
    } else {
      // Sem navGrid: grade neutra só para o HUD não ficar com um buraco preto.
      g.strokeStyle = 'rgba(233,229,219,.06)';
      g.lineWidth = 1;
      const passo = S / 6;
      for (let i = 1; i < 6; i++) {
        g.beginPath(); g.moveTo(i * passo, 0); g.lineTo(i * passo, S); g.stroke();
        g.beginPath(); g.moveTo(0, i * passo); g.lineTo(S, i * passo); g.stroke();
      }
    }

    /* ---------- cone de visão ---------- */
    const abert = 0.62;   // ~71° total
    g.save();
    g.translate(meio, meio);
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, S * 0.42);
    grad.addColorStop(0, 'rgba(232,135,60,.30)');
    grad.addColorStop(1, 'rgba(232,135,60,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, 0);
    g.arc(0, 0, S * 0.42, -Math.PI / 2 - abert, -Math.PI / 2 + abert);
    g.closePath();
    g.fill();
    g.restore();

    /* ---------- blips ---------- */
    const blips = this._coletarBlips(this._tmpBlips || (this._tmpBlips = []));
    if (blips.length) {
      const c = Math.cos(-rumoRad), s = Math.sin(-rumoRad);
      const raioMax = meio - 5 * this.dpr;
      for (const b of blips) {
        const dx = ((b.x - px) / cs) * escala;
        const dz = ((b.z - pz) / cs) * escala;
        let sx = dx * c - dz * s;
        let sy = dx * s + dz * c;
        const dist = Math.hypot(sx, sy);

        /* Três faixas de distância REAL (metros), não posição na tela:
         *   perto  (< 18 m)  triângulo cheio e grande — ameaça imediata
         *   médio  (18–42 m) triângulo VAZADO e menor — sei que existe, não
         *                    sei exatamente onde; é a dica que faltava
         *   longe  (> 42 m)  losango pequeno e apagado, preso na borda
         * Sem a faixa do meio o jogador só tinha "em cima de mim" ou "sumiu". */
        const distM = Math.hypot(b.x - px, b.z - pz);
        const faixa = distM < 18 ? 'perto' : (distM < 42 ? 'medio' : 'longe');

        let alfa = faixa === 'perto' ? 1 : (faixa === 'medio' ? 0.78 : 0.5);
        if (dist > raioMax) {          // fora do recorte: gruda na borda
          sx = (sx / dist) * raioMax;
          sy = (sy / dist) * raioMax;
          alfa = Math.min(alfa, 0.45);
        }
        const tipo = b.tipo || 'hostil';
        g.save();
        g.translate(meio + sx, meio + sy);
        g.globalAlpha = alfa;
        if (tipo === 'objetivo') {
          g.fillStyle = '#c4571b';
          g.rotate(Math.PI / 4);
          const r = 4.4 * this.dpr;
          g.fillRect(-r, -r, r * 2, r * 2);
        } else if (tipo === 'aliado') {
          g.fillStyle = '#63a7d8';
          g.beginPath(); g.arc(0, 0, 3.8 * this.dpr, 0, Math.PI * 2); g.fill();
        } else if (faixa === 'longe') {
          // losango pequeno: presença distante, direção aproximada
          const r = 3.4 * this.dpr;
          g.beginPath();
          g.moveTo(0, -r); g.lineTo(r, 0); g.lineTo(0, r); g.lineTo(-r, 0);
          g.closePath();
          g.fillStyle = '#8e2a20';
          g.strokeStyle = 'rgba(0,0,0,.8)';
          g.lineWidth = 1 * this.dpr;
          g.fill(); g.stroke();
        } else {
          // hostil: triângulo vermelho com contorno preto (lê em qualquer fundo).
          // Na faixa média fica VAZADO — a silhueta some no fundo se for cheia,
          // e é justamente essa leitura de "menos certeza" que queremos.
          const perto = faixa === 'perto';
          const r = (perto ? 5.2 : 4.3) * this.dpr;
          g.beginPath();
          g.moveTo(0, -r); g.lineTo(r * 0.92, r * 0.75); g.lineTo(-r * 0.92, r * 0.75);
          g.closePath();
          g.strokeStyle = 'rgba(0,0,0,.85)';
          g.lineWidth = 1.2 * this.dpr;
          if (perto) {
            g.fillStyle = b.firing ? '#ff6a4a' : '#d8281a';
            g.fill(); g.stroke();
          } else {
            g.stroke();
            g.strokeStyle = b.firing ? '#ff6a4a' : '#d8281a';
            g.lineWidth = 1.6 * this.dpr;
            g.stroke();
          }
        }
        g.restore();
      }
    }

    /* ---------- jogador ---------- */
    g.save();
    g.translate(meio, meio);
    g.beginPath();
    const r = 4.2 * this.dpr;
    g.moveTo(0, -r * 1.25);
    g.lineTo(r * 0.85, r * 0.9);
    g.lineTo(0, r * 0.45);
    g.lineTo(-r * 0.85, r * 0.9);
    g.closePath();
    g.fillStyle = '#f2efe8';
    g.strokeStyle = 'rgba(0,0,0,.9)';
    g.lineWidth = 1.2 * this.dpr;
    g.fill(); g.stroke();
    g.restore();

    /* ---------- rosa dos ventos (só o N) ---------- */
    g.save();
    g.translate(meio, meio);
    g.rotate(-rumoRad);
    g.translate(0, -(meio - 9 * this.dpr));
    g.rotate(rumoRad);
    g.fillStyle = 'rgba(232,135,60,.9)';
    g.font = `600 ${Math.round(9 * this.dpr)}px Bahnschrift, "Arial Narrow", Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('N', 0, 0);
    g.restore();

    /* ---------- vinheta de borda: tira o corte seco do recorte ---------- */
    const vg = g.createRadialGradient(meio, meio, S * 0.30, meio, meio, S * 0.62);
    vg.addColorStop(0, 'rgba(6,8,10,0)');
    vg.addColorStop(1, 'rgba(6,8,10,.55)');
    g.fillStyle = vg;
    g.fillRect(0, 0, S, S);
  }

  dispose() { this.base = null; this.grid = null; this._blips.length = 0; }
}
