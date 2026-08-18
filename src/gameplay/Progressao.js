/**
 * Progressao — ondas, composição, meta de abates e escalada de dificuldade.
 *
 * Assume o controle do spawn: desliga o repovoamento automático do AIManager e
 * passa a ditar quantos hostis existem, DE QUE TIPO, com que frequência nascem
 * e quão bons eles são.
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
 *
 * A onda 1 foi REFEITA (ver `simultaneosDaOnda`)
 * ----------------------------------------------
 * A curva antiga entregava 6 hostis vivos e 3 atirando já na primeira onda. Ela
 * tinha sido calibrada quando a IA era passiva: o hostil não ouvia tiro, não
 * varria o olhar e o reforço nascia do outro lado do morro. Depois que ele
 * passou a escutar, a virar a cabeça e a nascer a 15-46 m, cada um desses
 * números passou a valer muito mais — 6 vivos hoje é o que 6 vivos NUNCA foi
 * antes. A entrada do jogo virou uma parede.
 *
 * Agora a onda 1 é 3 vivos e 2 atirando, e a rampa até o teto foi esticada da
 * onda 4 para a onda 10. O intervalo de reforço encurtou junto (era 7,9 s na
 * onda 1): com o campo mais magro, esperar 8 s por dois hostis viraria tempo
 * morto. A ideia que já estava no código continua — simultâneos ACIMA da meta,
 * para o jogador enfrentar mais gente do que precisa matar —, só que partindo
 * de mais baixo.
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

/**
 * COMPOSIÇÃO POR ONDA — tabela declarativa.
 * ==========================================
 *
 * Uma linha por onda. O que não estiver escrito aqui cai na curva padrão
 * (`metaDaOnda`, `simultaneosDaOnda`, `atiradoresDaOnda`, `intervaloReforco`).
 *
 * Por que uma TABELA e não condicional espalhada: composição de onda é a coisa
 * que mais vai ser mexida daqui pra frente — "a 3 ficou pesada", "põe drone na
 * 5 também", "adianta o enxame". Com uma tabela isso é editar uma linha e
 * medir. Com `if (onda === 3)` espalhado por `_iniciarOnda` e `update` é caçar
 * o comportamento em três lugares e esquecer um.
 *
 * Campos:
 *   drones       quantos dos simultâneos são drones. `'tudo'` = onda temática.
 *   rotulo       nome da onda, anunciado no HUD.
 *   meta         abates para fechar (sobrescreve a curva)
 *   simultaneos  vivos em campo ao mesmo tempo (sobrescreve a curva)
 *   atiradores   teto de fogo simultâneo (sobrescreve a curva)
 *   intervalo    segundos entre levas de reforço (sobrescreve a curva)
 *
 * O ENXAME PEDE A PRÓPRIA CONTAGEM. Drone é mais fácil de acertar (envelope de
 * 42 cm, e ele PARA no ar antes de cada rajada) e muito mais frágil (70 hp
 * contra 100, três tiros de fuzil no casco). Fechar a onda 3 com a meta da
 * curva de chão — 6 abates — daria uma onda temática mais curta que a onda 2.
 * Por isso 10 abates com 8 em campo: mesmo tempo de onda, densidade que
 * justifica a palavra "enxame", e o teto de atiradores em 3 para o enxame ser
 * um problema de POSIÇÃO e não uma chuva de fogo.
 */
const COMPOSICAO = {
  /* 1 — a apresentação. Magra de propósito: é aqui que o jogador descobre que
   *     a máquina escuta o tiro dele e vira a cabeça. Com 6 vivos ele não
   *     descobre nada, só morre. */
  1: { drones: 0, rotulo: 'PATRULHA' },
  /* 2 — UM drone entre os de chão. Apresenta o bicho: o zumbido chega antes
   *     dele, ele paira, telegrafa e atira. Um só, para dar tempo de olhar. */
  2: { drones: 1, rotulo: 'BATEDOR' },
  /* 3 — ENXAME. A onda temática pedida. Só drone, aos montes. */
  3: {
    drones: 'tudo', rotulo: 'ENXAME',
    meta: 10, simultaneos: 8, atiradores: 3, intervalo: 3.2,
  },
  4: { drones: 1 },
  5: { drones: 2, rotulo: 'CERCO' },
  6: { drones: 2 },
  7: { drones: 3 },
  /* 8 — segundo enxame, agora com o perfil de IA já em VETERANO e com hostis
   *     de chão junto: o mesmo tema, resolvido de outro jeito. */
  8: {
    drones: 'tudo', rotulo: 'ENXAME CERRADO',
    meta: 16, simultaneos: 11, atiradores: 4, intervalo: 2.8,
  },
};

/** Ondas além da tabela: enxame a cada 5, e uma pitada de drone no resto. */
function composicaoPadrao(n) {
  if (n % 5 === 3) {
    return {
      drones: 'tudo', rotulo: 'ENXAME',
      simultaneos: Math.min(12, 8 + Math.floor((n - 3) / 5)),
      atiradores: 4,
      intervalo: 2.8,
    };
  }
  return { drones: Math.min(4, 1 + Math.floor(n / 6)) };
}

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
    this.rotuloOnda = null;    // nome temático da onda atual ('ENXAME', ...)
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

  /** Composição declarada da onda `n` (tabela, ou a regra padrão). */
  composicaoDaOnda(n) { return COMPOSICAO[n] ?? composicaoPadrao(n); }

  /**
   * Quantos abates a onda `n` exige.
   *
   * Onda 1 pede 3 e não 5: a primeira onda é a que ensina, e ela tem de acabar
   * antes de virar rotina. A inclinação (1,45/onda) é praticamente a mesma de
   * antes (1,6) — o que mudou foi o ponto de partida, não o ritmo.
   */
  metaDaOnda(n) {
    return this.composicaoDaOnda(n).meta ?? Math.round(2 + n * 1.45);
  }

  /**
   * Quantos hostis podem existir ao mesmo tempo na onda `n`.
   *
   * Fica DE PROPÓSITO acima da meta: o jogador enfrenta mais gente do que
   * precisa matar, e os primeiros abates é que contam. Isso não mudou.
   *
   * O QUE MUDOU: começa em 3 (era 6) e leva até a onda 10 para chegar ao teto
   * de 12 (era onda 8). A curva antiga foi calibrada com uma IA que não ouvia
   * tiro, não varria o olhar e cujo reforço nascia a 130 m — seis daqueles
   * hostis eram menos gente do que três destes. Quem for reajustar ritmo mexe
   * AQUI e em `atiradoresDaOnda`, não em precisão: precisão é o eixo que o
   * ARCHITECTURE.md manda escalar por competência, não por volume.
   */
  simultaneosDaOnda(n) {
    return this.composicaoDaOnda(n).simultaneos ?? Math.min(2 + Math.ceil(n * 0.95), 12);
  }

  /**
   * Segundos entre levas de reforço.
   *
   * Encurtou no começo (6,7 s na onda 1, era 7,9 s) exatamente porque o campo
   * ficou mais magro: com 3 vivos em vez de 6, esperar 8 s pelo próximo par é
   * tempo morto, não tensão. O piso (3,0 s) e as ondas altas ficaram onde
   * estavam — a mudança é de entrada, não de teto.
   */
  intervaloReforco(n) {
    return this.composicaoDaOnda(n).intervalo ?? Math.max(3.0, 7.2 - n * 0.52);
  }

  /**
   * Quantos hostis podem estar ATIRANDO no jogador ao mesmo tempo.
   *
   * Sobe MUITO devagar de propósito. É este número, e não a precisão, que
   * decide se a onda é tensa ou injusta: oito fuzis abrindo fogo juntos a 7 m
   * matam qualquer um em menos de um segundo e não há jogada que resolva.
   * Com o teto, o excedente flanqueia e cerca — a mesma gente em campo, mas
   * o jogador enfrenta um problema de POSIÇÃO em vez de um pelotão de fuzilamento.
   *
   * Começa em 2 (era 3). Três fuzis competentes na primeira onda, agora que
   * eles convergem de verdade, é mais do que uma entrada aguenta.
   *
   * Vale para drone também: `PAIRAR` e `ATIRAR` ocupam vaga (ver
   * `AIManager.vagaDeFogo`). É o que impede o enxame de virar parede de dano.
   */
  atiradoresDaOnda(n) {
    return this.composicaoDaOnda(n).atiradores
      ?? (n <= 2 ? 2 : n <= 6 ? 3 : n <= 12 ? 4 : 5);
  }

  /**
   * Quantos dos simultâneos da onda `n` são drones.
   * `'tudo'` na tabela = onda temática, o campo inteiro voa.
   */
  dronesDaOnda(n) {
    const d = this.composicaoDaOnda(n).drones ?? 0;
    const simult = this.simultaneosDaOnda(n);
    return d === 'tudo' ? simult : Math.min(d, simult);
  }

  /**
   * Perfil de IA da onda. Ondas 1–5 vão de fácil a normal; 6–13 de normal a
   * difícil; daí em diante continua endurecendo além do preset difícil, mas
   * com teto — passado certo ponto vira injusto, não desafiador.
   *
   * A primeira faixa esticou de 4 para 5 ondas junto com o resto da rampa: a
   * onda 1 é fácil PURO (era fácil puro também, mas já na 4 estava em normal
   * cheio, com 9 hostis em campo).
   */
  perfilDaOnda(n) {
    if (n <= 5) return misturar(DIFICULDADE.facil, DIFICULDADE.normal, (n - 1) / 4);
    if (n <= 13) return misturar(DIFICULDADE.normal, DIFICULDADE.dificil, (n - 5) / 8);
    const extra = Math.min(1, (n - 13) / 10);
    const alem = {
      ...DIFICULDADE.dificil,
      reacao: [0.13, 0.24], erro0: 0.05, erroMin: 0.006,
      converge: 4.8, rajada: [6, 11], pausa: [0.22, 0.5],
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
    ai.maxAtiradores = this.atiradoresDaOnda(this.onda);
    ai.maxDrones = this.dronesDaOnda(this.onda);

    /* Aplica o perfil a TODO o pool — hostis de chão E drones. Os inimigos são
     * reutilizados, então mudar só o que nasce agora deixaria veteranos com a
     * dificuldade antiga. `ai.pool` é a lista unificada exatamente para que
     * esta linha não precise saber que existem dois tipos. */
    const perfil = this.perfilDaOnda(this.onda);
    for (const e of ai.pool) e.dif = perfil;

    const comp = this.composicaoDaOnda(this.onda);
    this.rotuloOnda = comp.rotulo ?? null;
    this.ctx.hud?.anunciarOnda?.(this.onda, this.meta, this.rotuloDificuldade);
    this.ctx.bus?.emit('onda:inicio', {
      onda: this.onda, meta: this.meta, dificuldade: this.rotuloDificuldade,
      rotulo: this.rotuloOnda, drones: ai.maxDrones, simultaneos: ai.maxVivos,
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

      /* Quantos dos que faltam têm de voar. A conta é sobre o que EXISTE em
       * campo, não sobre o que já nasceu: numa onda de enxame o jogador derruba
       * drones o tempo todo, e o repovoamento tem de repor drone, não trocar o
       * enxame por infantaria no meio da onda temática. */
      const dronesVivos = ai.contarDrones?.() ?? 0;
      const faltamDrones = Math.max(0, ai.maxDrones - dronesVivos);
      const pedirDrone = Math.min(pedir, faltamDrones);
      const pedirSolo = pedir - pedirDrone;

      /* 15 m em vez de 24: as máquinas operam em rede e sabem onde o alvo está.
       * Com 24 m o jogador passava mais tempo caminhando do que atirando.
       *
       * O TETO de 46 m é tão importante quanto o piso, e faltava. Sem ele o
       * reforço nascia em qualquer ponto válido do mapa — medido a 176 m num
       * mapa de 180 m. Quem nasce longe demais nunca chega, mas ocupa a vaga:
       * o campo fica "cheio" e nenhum hostil novo é chamado.
       *
       * O drone nasce MAIS LONGE (22-58 m) de propósito, e isso é justiça, não
       * sabor: o zumbido é o aviso principal de que ele existe, e a 15 m ele
       * chegaria junto com o próprio som. A 22 m, voando a 6,5 m/s, o jogador
       * tem uns dois segundos de zumbido crescendo antes de o bicho aparecer na
       * esquina — que é o tempo de virar e procurar. */
      let feitos = 0;
      if (pedirSolo > 0) feitos += ai.spawnOnda(pedirSolo, 15, 46, 'solo');
      if (pedirDrone > 0) feitos += ai.spawnOnda(pedirDrone, 22, 58, 'drone');

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
      rotulo: this.rotuloOnda ?? null,
      simultaneos: this.simultaneosDaOnda(this.onda),
      drones: this.dronesDaOnda(this.onda),
      atiradores: this.atiradoresDaOnda(this.onda),
      intervalo: this.intervaloReforco(this.onda),
    };
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
  }
}

export { FASE };
export default Progressao;
