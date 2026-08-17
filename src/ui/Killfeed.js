/**
 * Killfeed — canto superior direito.
 * Dono: agente UI.
 *
 * Formato: AUTOR ⟶ [silhueta da arma + traçado] ⟶ ALVO, com selo de headshot.
 * A "seta" do briefing é o próprio traçado pontilhado que sai do cano da arma
 * e aponta para o nome do alvo — lê como direção sem poluir a linha com
 * caracteres tipográficos.
 *
 * Cada linha vive 5 s e sai por opacidade + transform (nunca por altura, que
 * causaria reflow de toda a pilha).
 */

const VIDA = 5.0;
const MAX_LINHAS = 5;

/* Silhuetas procedurais — viewBox 0 0 78 22, cano apontando para a direita.
   Traçado pontilhado de 58→77 faz o papel do "⟶". */
const ARMAS = {
  fuzil:
    '<path d="M2 9h6v3H2z"/><path d="M8 8h9v5H8z"/><path d="M17 9h22v3H17z"/>' +
    '<path d="M39 9.6h15v1.8H39z"/><path d="M20 12h5l-1.5 7H18z"/>' +
    '<path d="M12 5.6h7v1.6h-7z"/><path d="M30 7.6h4v1.4h-4z"/>',
  smg:
    '<path d="M4 9h5v3H4z"/><path d="M9 8h8v5H9z"/><path d="M17 9h13v3H17z"/>' +
    '<path d="M30 9.6h9v1.8h-9z"/><path d="M14 12h4.5l-1 6h-4z"/>' +
    '<path d="M12 5.8h6v1.5h-6z"/>',
  pistola:
    '<path d="M12 8h16v4H12z"/><path d="M28 9h6v2.4h-6z"/>' +
    '<path d="M13 12h5l-2.5 8h-5z"/><path d="M15 6.2h8v1.5h-8z"/>',
  faca:
    '<path d="M8 10.2 L26 7.4 L30 10.6 L26 13.6 L8 11.8 Z"/><path d="M4 9.4h5v3h-5z"/>',
};
const TRACO = '<path d="M58 10.4h4v1.4h-4zM65 10.4h4v1.4h-4zM72 10.4h5v1.4h-5z" opacity=".55"/>';

/** id/nome da arma -> classe de silhueta. */
function classeDaArma(w) {
  const s = String(w ?? '').toLowerCase();
  if (!s) return 'fuzil';
  if (s.includes('pt92') || s.includes('pistol') || s.includes('taurus pt')) return 'pistola';
  if (s.includes('smt') || s.includes('smg') || s.includes('submetr')) return 'smg';
  if (s.includes('faca') || s.includes('melee') || s.includes('coronha')) return 'faca';
  return 'fuzil';
}

/** Nome de exibição do hostil a partir do id numérico da IA. */
function nomeHostil(id) {
  if (id === undefined || id === null) return 'HOSTIL';
  const n = typeof id === 'number' ? id : parseInt(String(id).replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? `HOSTIL ${String(n % 100).padStart(2, '0')}` : 'HOSTIL';
}

export class Killfeed {
  /** @param {HTMLElement} host elemento `.hud-feed` já no DOM */
  constructor(host) {
    this.host = host;
    this.linhas = [];
    this.reduzido = matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /**
   * @param {string} autor
   * @param {string} alvo
   * @param {object} o `{arma, headshot, propria}`
   */
  add(autor, alvo, o = {}) {
    const el = document.createElement('div');
    el.className = 'feed-linha' + (o.propria ? ' propria' : '');
    const cls = classeDaArma(o.arma);

    /* Nome SEMPRE por textContent, nunca interpolado em innerHTML.
     *
     * Hoje os dois nomes sao seguros por construcao: `nomeHostil()` descarta
     * todo caractere nao numerico e devolve "HOSTIL NN", e o outro lado e o
     * literal "VOCE". Ou seja, isto nao corrige uma falha existente — fecha a
     * porta antes. No dia em que existir nome de jogador editavel (apelido,
     * multiplayer, replay salvo), esta era exatamente a linha que viraria XSS,
     * e quem for acrescentar essa funcionalidade nao tem por que saber disso.
     *
     * A marcacao de SVG abaixo continua por innerHTML porque e 100% literal,
     * montada so a partir das constantes deste modulo. Nenhum dado entra nela.
     * A ESTRUTURA DO DOM e identica a de antes (span.autor, [svg.hs], svg.arma,
     * span.alvo como filhos diretos) — o CSS em styles.css depende disso. */
    const elAutor = document.createElement('span');
    elAutor.className = 'autor';
    elAutor.textContent = autor;
    el.appendChild(elAutor);

    const svgs = document.createElement('div');
    svgs.innerHTML =
      (o.headshot
        ? '<svg class="hs" viewBox="0 0 16 16" aria-label="tiro na cabeça">' +
          '<path d="M8 1.4c-2.6 0-4.3 1.8-4.3 4.2 0 1.5.6 2.4 1.3 3.1.5.5.7.9.7 1.6v1.1h4.6v-1.1c0-.7.2-1.1.7-1.6.7-.7 1.3-1.6 1.3-3.1 0-2.4-1.7-4.2-4.3-4.2z"/>' +
          '<circle cx="8" cy="5.4" r="1.9" fill="#0a0b0d"/>' +
          '<path d="M5.2 13.2h5.6v1.4H5.2z"/></svg>'
        : '') +
      `<svg class="arma" viewBox="0 0 78 22" aria-hidden="true">${ARMAS[cls] ?? ARMAS.fuzil}${TRACO}</svg>`;
    while (svgs.firstChild) el.appendChild(svgs.firstChild);

    const elAlvo = document.createElement('span');
    elAlvo.className = 'alvo';
    elAlvo.textContent = alvo;
    el.appendChild(elAlvo);

    this.host.appendChild(el);
    this.linhas.push({ el, t: 0 });

    if (!this.reduzido) {
      el.animate(
        [{ opacity: 0, transform: 'translateX(18px) scaleX(.96)' }, { opacity: 1, transform: 'none' }],
        { duration: 170, easing: 'cubic-bezier(.2,.75,.25,1)' },
      );
    }

    while (this.linhas.length > MAX_LINHAS) {
      const velha = this.linhas.shift();
      velha.el.remove();
    }
  }

  /** Abate do jogador. */
  abate(enemyId, headshot, arma) {
    this.add('VOCÊ', nomeHostil(enemyId), { arma, headshot, propria: true });
  }

  /** Morte do jogador (não sabemos o autor: fica genérico). */
  morte(arma) {
    this.add('HOSTIL', 'VOCÊ', { arma, headshot: false, propria: false });
  }

  update(dt) {
    for (let i = this.linhas.length - 1; i >= 0; i--) {
      const l = this.linhas[i];
      l.t += dt;
      if (l.t > VIDA) {
        if (!l.saindo) {
          l.saindo = true;
          const an = l.el.animate(
            [{ opacity: 1 }, { opacity: 0, transform: 'translateX(10px)' }],
            { duration: this.reduzido ? 1 : 260, easing: 'linear', fill: 'forwards' },
          );
          an.onfinish = () => l.el.remove();
        }
        if (l.t > VIDA + 0.4) this.linhas.splice(i, 1);
      }
    }
  }

  limpar() {
    for (const l of this.linhas) l.el.remove();
    this.linhas.length = 0;
  }

  dispose() { this.limpar(); }
}
