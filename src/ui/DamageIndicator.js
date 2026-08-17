/**
 * DamageIndicator — arcos vermelhos apontando para a origem do dano.
 * Dono: agente UI.
 *
 * O ângulo é resolvido no espaço da câmera: pegamos o rumo do agressor no
 * mundo e subtraímos o rumo da câmera (só o componente de guinada — o arco
 * vive no plano da tela, o pitch não deve girá-lo).
 *
 * Convenção de `player:damaged.fromDir` — ver NOTES.md, seção [UI]:
 * é a direção de PROPAGAÇÃO do tiro (do agressor para o jogador), a mesma
 * que o `CameraRig.addShake` usa para empurrar a câmera. Logo o agressor
 * está em `-fromDir`. Se o payload trouxer uma posição (`sourcePosition`,
 * `origin` ou `source.position`), ela tem prioridade por ser inequívoca.
 */

const MAX_ARCOS = 5;
const VIDA = 1.5;          // segundos até sumir de vez
const REAGRUPA = 22;       // graus: dano na mesma direção reacende o mesmo arco

/** Constrói um arco em forma de lente (grosso no meio, fino nas pontas). */
function caminhoArco(meioAngGraus, raio, espessura, amostras = 26) {
  const meio = (meioAngGraus * Math.PI) / 180;
  const fora = [];
  const dentro = [];
  for (let i = 0; i <= amostras; i++) {
    const u = i / amostras;
    // -90° põe o zero do arco no topo da tela (12 horas).
    const a = -Math.PI / 2 + (u * 2 - 1) * meio;
    const afila = Math.sin(Math.PI * u) ** 0.55;   // afina as pontas
    const e = (espessura * 0.5) * afila;
    const ce = Math.cos(a), se = Math.sin(a);
    fora.push([(raio + e) * ce, (raio + e) * se]);
    dentro.push([(raio - e) * ce, (raio - e) * se]);
  }
  const p = [];
  p.push(`M ${fora[0][0].toFixed(2)} ${fora[0][1].toFixed(2)}`);
  for (let i = 1; i < fora.length; i++) p.push(`L ${fora[i][0].toFixed(2)} ${fora[i][1].toFixed(2)}`);
  for (let i = dentro.length - 1; i >= 0; i--) p.push(`L ${dentro[i][0].toFixed(2)} ${dentro[i][1].toFixed(2)}`);
  p.push('Z');
  return p.join(' ');
}

export class DamageIndicator {
  /**
   * @param {HTMLElement} host elemento `.hud-dano` já no DOM
   * @param {object} ctx GameContext (pode estar incompleto)
   */
  constructor(host, ctx) {
    this.host = host;
    this.ctx = ctx;
    this.arcos = [];
    this._svgArco = caminhoArco(21, 78, 15);
    this._svgSombra = caminhoArco(23, 78, 21);

    for (let i = 0; i < MAX_ARCOS; i++) {
      const el = document.createElement('div');
      el.className = 'arco';
      el.innerHTML =
        `<svg viewBox="-100 -100 200 200" aria-hidden="true">` +
        `<path class="contorno" d="${this._svgSombra}"/>` +
        `<path class="lamina" d="${this._svgArco}"/>` +
        `</svg>`;
      host.appendChild(el);
      this.arcos.push({ el, ativo: false, t: 0, ang: 0, forca: 0 });
    }
  }

  /**
   * Registra um dano.
   * @param {number} rumoRelativo graus, 0 = frente, positivo = horário
   * @param {number} forca 0..1 (proporcional ao dano)
   */
  marcar(rumoRelativo, forca = 0.5) {
    const ang = ((rumoRelativo % 360) + 540) % 360 - 180;

    // Reacende um arco próximo em vez de empilhar dois quase iguais.
    let alvo = null;
    for (const a of this.arcos) {
      if (a.ativo && Math.abs(((a.ang - ang + 540) % 360) - 180) < REAGRUPA) { alvo = a; break; }
    }
    if (!alvo) {
      // Livre, senão o mais velho.
      alvo = this.arcos.find((a) => !a.ativo);
      if (!alvo) alvo = this.arcos.reduce((m, a) => (a.t > m.t ? a : m), this.arcos[0]);
    }

    alvo.ativo = true;
    alvo.t = 0;
    alvo.ang = ang;
    alvo.forca = Math.max(alvo.forca * 0.6, Math.min(1, forca));
    // Escala: dano forte = arco maior. Só transform/opacity.
    const esc = 0.92 + alvo.forca * 0.16;
    alvo.el.style.transform = `rotate(${ang.toFixed(1)}deg) scale(${esc.toFixed(3)})`;
    alvo.el.style.opacity = String(0.55 + alvo.forca * 0.45);
  }

  /** Converte uma direção de mundo em rumo relativo e marca. */
  marcarDirecao(dirX, dirZ, rumoCamGraus, forca) {
    // rumo absoluto do agressor: 0 = norte (-Z), horário para leste (+X)
    const rumo = (Math.atan2(dirX, -dirZ) * 180) / Math.PI;
    this.marcar(rumo - rumoCamGraus, forca);
  }

  update(dt) {
    for (const a of this.arcos) {
      if (!a.ativo) continue;
      a.t += dt;
      if (a.t >= VIDA) {
        a.ativo = false;
        a.forca = 0;
        a.el.style.opacity = '0';
        continue;
      }
      const u = a.t / VIDA;
      // Segura no começo, some no fim (curva de decaimento rápido no final).
      const k = u < 0.35 ? 1 : 1 - (u - 0.35) / 0.65;
      a.el.style.opacity = ((0.55 + a.forca * 0.45) * k * k).toFixed(3);
    }
  }

  limpar() {
    for (const a of this.arcos) { a.ativo = false; a.forca = 0; a.el.style.opacity = '0'; }
  }

  dispose() {
    for (const a of this.arcos) a.el.remove();
    this.arcos.length = 0;
  }
}
