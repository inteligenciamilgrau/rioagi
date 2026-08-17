/**
 * Progressao — ondas, meta de abates e escalada de dificuldade.
 *
 * Assume o controle do spawn: desliga o repovoamento automático do AIManager e
 * passa a ditar quantos hostis existem, com que frequência nascem e quão bons
 * eles são.
 *
 * Curva de dificuldade
 * --------------------
 * Três eixos sobem juntos, mas em ritmos diferentes — é isso que evita que o
 * jogo vire "mesma luta com mais vida":
 *
 *   1. VOLUME    quantos abates a onda exige, e quantos hostis simultâneos.
 *   2. COMPETÊNCIA tempo de reação e precisão da IA (interpolado de forma
 *      contínua, não em três degraus).
 *   3. PRESSÃO   intervalo entre reforços encurta.
 *
 * O dano por tiro sobe MUITO pouco de propósito. Dificuldade que vem de dano
 * bruto só faz o jogador morrer sem entender; dificuldade que vem de reação e
 * precisão faz ele jogar melhor.
 */
import { DIFICULDADE } from '../ai/Enemy.js';

/** Interpola linearmente entre dois perfis de dificuldade. */
function misturar(a, b, t) {
  const l = (x, y) => x + (y - x) * t;
  return {
    reacao: [l(a.reacao[0], b.reacao[0]), l(a.reacao[1], b.reacao[1])],
    erro0: l(a.erro0, b.erro0),
    erroMin: l(a.erroMin, b.erroMin),
    converge: l(a.converge, b.converge),
    rajada: [Math.round(l(a.rajada[0], b.rajada[0])), Math.round(l(a.rajada[1], b.rajada[1]))],
    pausa: [l(a.pausa[0], b.pausa[0]), l(a.pausa[1], b.pausa[1])],
    dano: l(a.dano, b.dano),
  };
}

/** Estado entre ondas. */
const FASE = { PREPARO: 'preparo', COMBATE: 'combate', INTERVALO: 'intervalo', FIM: 'fim' };

export class Progressao {
  constructor(ctx) {
    this.ctx = ctx;
    this.pausable = true;

    this.onda = 0;
    this.meta = 0;
    this.abates = 0;
    this.abatesTotais = 0;
    this.fase = FASE.PREPARO;
    this.tFase = 0;
    this._tReforco = 0;
    this._offs = [];
  }

  async init() {
    const bus = this.ctx.bus;
    this._offs.push(bus.on('enemy:killed', () => this._aoAbater()));
    this._offs.push(bus.on('game:start', () => this.reiniciar()));
    this._offs.push(bus.on('player:died', () => { this.fase = FASE.FIM; }));
    return this;
  }

  /* ------------------------------------------------------------------ */
  /* Curva                                                               */
  /* ------------------------------------------------------------------ */

  /** Quantos abates a onda `n` exige. */
  metaDaOnda(n) { return 4 + Math.floor(n * 1.6); }

  /**
   * Quantos hostis podem existir ao mesmo tempo na onda `n`.
   * Fica DE PROPÓSITO acima da meta nas primeiras ondas: o jogador enfrenta
   * mais gente do que precisa matar, e os primeiros abates é que contam.
   */
  simultaneosDaOnda(n) { return Math.min(5 + Math.floor(n * 0.7), 12); }

  /** Segundos entre levas de reforço. */
  intervaloReforco(n) { return Math.max(3.5, 9 - n * 0.55); }

  /**
   * Perfil de IA da onda. Ondas 1–4 vão de fácil a normal; 5–12 de normal a
   * difícil; daí em diante continua endurecendo além do preset difícil, mas
   * com teto — passado certo ponto vira injusto, não desafiador.
   */
  perfilDaOnda(n) {
    if (n <= 4) return misturar(DIFICULDADE.facil, DIFICULDADE.normal, (n - 1) / 3);
    if (n <= 12) return misturar(DIFICULDADE.normal, DIFICULDADE.dificil, (n - 4) / 8);
    const extra = Math.min(1, (n - 12) / 10);
    const alem = {
      ...DIFICULDADE.dificil,
      reacao: [0.16, 0.30], erro0: 0.055, erroMin: 0.007,
      converge: 4.4, rajada: [5, 10], pausa: [0.26, 0.6],
      dano: DIFICULDADE.dificil.dano + 2,
    };
    return misturar(DIFICULDADE.dificil, alem, extra);
  }

  /** Rótulo legível da dificuldade atual, para o HUD. */
  get rotuloDificuldade() {
    const n = this.onda;
    if (n <= 4) return 'RECRUTA';
    if (n <= 8) return 'VETERANO';
    if (n <= 12) return 'ENDURECIDO';
    if (n <= 18) return 'BRUTAL';
    return 'INFERNO';
  }

  /* ------------------------------------------------------------------ */

  reiniciar() {
    this.onda = 0;
    this.abates = 0;
    this.abatesTotais = 0;
    this.ctx.ai.spawnAutomatico = false;   // quem manda no spawn agora e este sistema
    this._proximaOnda(1.5);
  }

  _proximaOnda(atraso = 3.0) {
    this.fase = FASE.INTERVALO;
    this.tFase = atraso;
  }

  _iniciarOnda() {
    this.onda++;
    this.abates = 0;
    this.meta = this.metaDaOnda(this.onda);
    this.fase = FASE.COMBATE;
    this.tFase = 0;
    this._tReforco = 0;

    const ai = this.ctx.ai;
    ai.maxVivos = this.simultaneosDaOnda(this.onda);

    // Aplica o perfil a TODO o pool: os inimigos são reutilizados, então mudar
    // só o que nasce agora deixaria veteranos com a dificuldade antiga.
    const perfil = this.perfilDaOnda(this.onda);
    for (const e of ai.pool) e.dif = perfil;

    this.ctx.hud?.anunciarOnda?.(this.onda, this.meta, this.rotuloDificuldade);
    this.ctx.bus?.emit('onda:inicio', {
      onda: this.onda, meta: this.meta, dificuldade: this.rotuloDificuldade,
    });
    this._emitirHud();
  }

  _aoAbater() {
    if (this.fase !== FASE.COMBATE) return;
    this.abates++;
    this.abatesTotais++;
    this._emitirHud();

    if (this.abates >= this.meta) {
      this.fase = FASE.INTERVALO;
      this.tFase = 6.0;
      this.ctx.ai.reset();                    // limpa quem sobrou em campo
      this.ctx.hud?.anunciarOndaLimpa?.(this.onda);
      this.ctx.bus?.emit('onda:limpa', { onda: this.onda, totais: this.abatesTotais });
    }
  }

  _emitirHud() {
    this.ctx.bus?.emit('onda:estado', {
      onda: this.onda,
      abates: this.abates,
      meta: this.meta,
      restam: Math.max(0, this.meta - this.abates),
      dificuldade: this.rotuloDificuldade,
      fase: this.fase,
    });
  }

  /* ------------------------------------------------------------------ */

  update(dt) {
    if (this.ctx.state !== 'jogando') return;
    if (this.fase === FASE.FIM) return;

    this.tFase -= dt;

    if (this.fase === FASE.INTERVALO || this.fase === FASE.PREPARO) {
      if (this.tFase <= 0) this._iniciarOnda();
      return;
    }

    /* --- combate: mantém o campo POVOADO ---
     *
     * O teto de hostis simultâneos NÃO é limitado pelo que falta matar. A meta
     * é só um contador: numa onda de 4 abates pode haver 6 inimigos em campo, e
     * os 4 primeiros que caírem fecham a onda. Amarrar o teto ao restante fazia
     * a onda esvaziar justamente no fim, quando deveria estar mais tensa. */
    const ai = this.ctx.ai;
    const vivos = ai.getEnemies().length;

    this._tReforco -= dt;
    if (vivos < ai.maxVivos && this._tReforco <= 0) {
      const pedir = Math.min(ai.maxVivos - vivos, 4);
      /* 15 m em vez de 24: as máquinas operam em rede e sabem onde o alvo está.
       * Com 24 m o jogador passava mais tempo caminhando do que atirando. */
      const feitos = ai.spawnOnda(pedir, 15);
      if (feitos > 0) {
        // Nasceram cientes: vão direto ao jogador em vez de patrulhar até
        // esbarrar nele por acaso.
        ai.convergirNoJogador();
        this._tReforco = this.intervaloReforco(this.onda);
      } else this._tReforco = 1.0;   // não achou lugar: tenta de novo logo
    }
  }

  estatisticas() {
    return {
      onda: this.onda, abates: this.abates, meta: this.meta,
      totais: this.abatesTotais, fase: this.fase,
      dificuldade: this.rotuloDificuldade,
    };
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
  }
}

export { FASE };
export default Progressao;
