/**
 * Musica — trilha adaptativa com rodízio de faixas de ação.
 *
 * Arquivos em `public/audio/musica/` (ver LEIA-ME.txt lá). Faixa ausente é
 * simplesmente ignorada: o jogo nunca quebra por falta de MP3.
 *
 * Quem toca o quê
 * ---------------
 *   menu / pausa / morte  ->  tensaonoar          (calma)
 *   onda em andamento     ->  uma das 3 de ação   (sorteada a cada onda)
 *   setor limpo           ->  doidera             (comemoração no intervalo)
 *
 * Só UMA faixa fica tocando por vez. As outras ficam pausadas — cinco
 * MediaElementSource decodificando em paralelo gasta CPU para produzir áudio
 * que ninguém ouve. A troca é: sobe a nova, desce a velha, e pausa a velha
 * quando o fade termina.
 *
 * O volume é do barramento de música do AudioEngine; aqui os ganhos são só
 * 0 ou 1 para a passagem cruzada.
 */

/* Caminho relativo a BASE_URL, nunca com barra na frente.
 *
 * PORQUE: '/audio/...' so funciona quando o jogo esta na raiz do dominio. No
 * GitHub Pages um repositorio comum serve em /nome-do-repo/, e todo caminho
 * absoluto vira 404. O Vite reescreve caminho absoluto em HTML e CSS, mas NAO
 * dentro de string de JS — aqui a conta e nossa. */
const BASE = `${import.meta.env.BASE_URL}audio/musica/`;

/** nome lógico -> arquivo. Acrescentar faixa de ação é só somar à lista. */
const FAIXAS = {
  calma: `${BASE}tensaonoar.mp3`,
  doidera: `${BASE}doidera.mp3`,
  acao1: `${BASE}becoemchamas.mp3`,
  acao2: `${BASE}radiacao.mp3`,
  acao3: `${BASE}ruasemfogo.mp3`,
};

/** Quais entram no rodízio de combate. */
const ACAO = ['acao1', 'acao2', 'acao3'];

const FADE_ENTRA = 1.6;
const FADE_SAI = 2.2;
/** Comemoração é curta e entra rápido, senão perde o impacto. */
const FADE_DOIDERA = 0.9;

export class Musica {
  constructor(ctx) {
    this.ctx = ctx;
    this.pausable = false;      // continua no menu e na pausa
    this.pronta = false;

    this.faixas = {};
    this.atual = null;          // nome lógico da faixa audível
    this.acaoDaVez = ACAO[0];
    this._comemorando = false;
    this._offs = [];
    this._ligado = false;
    this._ultimaAcao = null;
  }

  async init() {
    const eng = this.ctx.audio;
    const actx = eng?.actx;
    if (!actx) return this;     // headless/screenshot: sai quieto

    const destino = eng.busMus ?? eng.busMusica ?? eng.master ?? actx.destination;

    for (const [nome, url] of Object.entries(FAIXAS)) {
      this.faixas[nome] = await this._carregar(actx, destino, url);
    }

    const ok = Object.entries(this.faixas).filter(([, f]) => f.ok).map(([n]) => n);
    if (!ok.length) {
      console.info('[Musica] nenhum MP3 em public/audio/musica/ — trilha desligada.');
      return this;
    }
    this.pronta = true;
    this._ligarEventos();
    this._armarGesto();
    console.info(`[Musica] ${ok.length} faixa(s): ${ok.join(', ')}`);
    return this;
  }

  /** Carrega uma faixa. Nunca lança: arquivo ausente vira `ok: false`. */
  _carregar(actx, destino, url) {
    return new Promise((resolve) => {
      const el = new Audio();
      el.src = url;
      el.loop = true;
      el.preload = 'metadata';   // não baixa tudo no boot; o play() completa
      el.crossOrigin = 'anonymous';

      const gain = actx.createGain();
      gain.gain.value = 0;
      gain.connect(destino);

      const pronto = () => {
        limpar();
        try {
          const fonte = actx.createMediaElementSource(el);
          fonte.connect(gain);
          resolve({ el, gain, fonte, ok: true });
        } catch (e) {
          console.warn('[Musica] não consegui rotear', url, e);
          resolve({ el, gain, ok: false });
        }
      };
      const falhou = () => { limpar(); resolve({ el, gain, ok: false }); };
      const limpar = () => {
        el.removeEventListener('loadedmetadata', pronto);
        el.removeEventListener('error', falhou);
        clearTimeout(t);
      };

      el.addEventListener('loadedmetadata', pronto, { once: true });
      el.addEventListener('error', falhou, { once: true });
      const t = setTimeout(falhou, 8000);
      el.load();
    });
  }

  /* ------------------------------------------------------------------ */

  _ligarEventos() {
    const bus = this.ctx.bus;
    const on = (n, f) => this._offs.push(bus.on(n, f));

    on('game:start', () => this._iniciarReproducao());
    on('input:locked', () => this._iniciarReproducao());

    // Nova onda: sorteia outra faixa de ação e volta ao combate.
    on('onda:inicio', () => {
      this._comemorando = false;
      this._sortearAcao();
      this._avaliar(true);
    });

    // Setor limpo: entra a doidera durante o intervalo.
    on('onda:limpa', () => {
      this._comemorando = true;
      this._avaliar(true);
    });

    on('player:died', () => { this._comemorando = false; this._avaliar(true); });
  }

  /** Escolhe uma faixa de ação diferente da anterior. */
  _sortearAcao() {
    const disp = ACAO.filter((n) => this.faixas[n]?.ok);
    if (!disp.length) return;
    let escolha = disp[(Math.random() * disp.length) | 0];
    if (disp.length > 1 && escolha === this._ultimaAcao) {
      // troca pela seguinte na lista: garante que nunca repete duas seguidas
      escolha = disp[(disp.indexOf(escolha) + 1) % disp.length];
    }
    this._ultimaAcao = escolha;
    this.acaoDaVez = escolha;
  }

  /** Qual faixa deveria estar tocando agora. */
  _faixaDesejada() {
    const jogando = this.ctx.state === 'jogando';
    if (!jogando) return 'calma';
    if (this._comemorando && this.faixas.doidera?.ok) return 'doidera';
    return this.acaoDaVez;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Tenta iniciar a reprodução. Só vale após gesto do usuário (autoplay).
   * `_ligado` só vira true quando o play() REALMENTE resolve — marcar antes
   * fazia a tentativa bloqueada do boot travar todas as seguintes.
   */
  async _iniciarReproducao() {
    if (!this.pronta || this._ligado) return;

    const actx = this.ctx.audio?.actx;
    if (actx?.state === 'suspended') {
      try { await actx.resume(); } catch { /* tenta tocar assim mesmo */ }
    }

    this._sortearAcao();
    const alvo = this._faixaDesejada();
    const f = this.faixas[alvo];
    if (!f?.ok) return;

    try { await f.el.play(); }
    catch { return; }           // bloqueado: novo gesto tentará de novo

    this._ligado = true;
    this._removerGesto?.();
    this.atual = alvo;
    this._rampa(f, 1, 0.8);
  }

  /** Rede: qualquer clique ou tecla destrava a música. */
  _armarGesto() {
    const tentar = () => this._iniciarReproducao();
    const opts = { capture: true };
    window.addEventListener('pointerdown', tentar, opts);
    window.addEventListener('keydown', tentar, opts);
    this._removerGesto = () => {
      window.removeEventListener('pointerdown', tentar, opts);
      window.removeEventListener('keydown', tentar, opts);
      this._removerGesto = null;
    };
  }

  /** Compara o desejado com o audível e faz a troca quando diferem. */
  _avaliar(imediato = false) {
    if (!this.pronta || !this._ligado) return;
    const alvo = this._faixaDesejada();
    if (alvo === this.atual) return;
    this._trocarPara(alvo, imediato);
  }

  _trocarPara(nome, imediato) {
    const novo = this.faixas[nome];
    if (!novo?.ok) return;
    const velho = this.atual ? this.faixas[this.atual] : null;

    const entra = nome === 'doidera' ? FADE_DOIDERA : FADE_ENTRA;
    const sai = imediato && nome === 'doidera' ? FADE_DOIDERA : FADE_SAI;

    // A nova faixa sempre começa do zero: é música diferente, não uma
    // continuação — emendar no meio soaria como corte de rádio.
    try { novo.el.currentTime = 0; } catch { /* alguns navegadores recusam antes de carregar */ }
    novo.el.play().catch(() => { /* segue mudo se o navegador recusar */ });
    this._rampa(novo, 1, entra);

    if (velho && velho !== novo) {
      this._rampa(velho, 0, sai);
      // pausa depois que o fade termina, para não cortar o som na cara
      clearTimeout(velho._parar);
      velho._parar = setTimeout(() => {
        if (this.faixas[this.atual] !== velho) velho.el.pause();
      }, (sai + 0.15) * 1000);
    }

    this.atual = nome;
  }

  _rampa(f, alvo, dur) {
    const actx = this.ctx.audio?.actx;
    if (!actx || !f?.ok) return;
    const t = actx.currentTime;
    const g = f.gain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.max(0.0001, g.value), t);
    g.exponentialRampToValueAtTime(Math.max(0.0001, alvo), t + dur);
    if (alvo === 0) g.setValueAtTime(0, t + dur + 0.01);
  }

  update() {
    if (!this.pronta || !this._ligado) return;
    this._avaliar();
  }

  /** Diagnóstico rápido (usado pelos scripts de teste). */
  estado() {
    return {
      tocando: this.atual,
      acaoDaVez: this.acaoDaVez,
      comemorando: this._comemorando,
      carregadas: Object.entries(this.faixas).filter(([, f]) => f.ok).map(([n]) => n),
    };
  }

  setQuality() { /* volume e do barramento de musica; nada a fazer aqui */ }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
    this._removerGesto?.();
    for (const f of Object.values(this.faixas)) {
      clearTimeout(f._parar);
      try { f.el.pause(); f.el.src = ''; } catch { /* ignora */ }
    }
  }
}

export default Musica;
