/**
 * AudioEngine — som 100% PROCEDURAL via WebAudio. Dono: FX.
 * Zero arquivos: nenhum .wav, .ogg ou .mp3 entra neste projeto.
 *
 * Cadeia de mixagem
 * -----------------
 *   vozes -> [passa-baixa de distancia/oclusao] -> PannerNode(HRTF) --\
 *         -> envioRua  -> convolver(IR rua)  ---------------------+--> busSfx --\
 *         -> envioBeco -> convolver(IR beco) ---------------------/             |
 *   busAmbiente (vento, cachorro, radio) -----------------------> busSfx        |
 *                                                                              |
 *   busSfx  (slider "Efeitos") ------------------> cola(compressor) -----------+
 *   busMus  (slider "Musica")  ------------------> master (slider "Volume geral")
 *                                                     -> limiter -> saida
 *
 * SAO TRES CONTROLES, e so tres. Tudo que e efeito — inclusive o AMBIENTE e a
 * CAUDA DE REVERB — passa por busSfx. Cauda saindo por fora do controle de
 * efeitos faz o eco do tiro continuar tocando com o volume zerado, e ficar
 * relativamente mais alto conforme se abaixa o slider.
 *
 * O tiro nao e "um som": sao quatro camadas somadas —
 *   1. transiente  ruido branco com ataque de ~1 ms (o estalo que fura o ouvido)
 *   2. corpo       ruido em passa-banda com varredura descendente (o "buummm")
 *   3. thump       senoide grave caindo de tom (peso, o que se sente no peito)
 *   4. mecanica    ferrolho: banda estreita e curta, atrasada uns 12 ms
 * mais a cauda convolvida. Trocar arma = trocar frequencias e tempos dessas
 * camadas, nao trocar amostra.
 *
 * "Eco de beco": o segundo convolver tem IR mais longa, com pre-delay e reflexoes
 * discretas espacadas (flutter entre paredes paralelas) e passa-baixa pesada. E
 * essa segunda cauda que faz soar favela, e nao estudio.
 *
 * O AudioContext so pode iniciar apos gesto do usuario. Ate la tudo degrada em
 * silencio — o agente de screenshot roda sem audio e nao pode quebrar.
 *
 * Orcamento de CPU: por que existe pool e por que existe cache
 * ------------------------------------------------------------
 * O som picotava com muitos hostis. Medido com tools/audiolab.mjs,
 * tools/audiocamada.mjs e tools/audiolixo.mjs (carga = tempo de parede para
 * renderizar 1 s de audio; 1.0 = a maquina nao da conta em tempo real, ou seja,
 * estalo garantido). Com 16 vozes ativas:
 *
 *   cadeias de voz paradas penduradas no grafo ............... 0.13  irrelevante
 *   os dois convolvers de reverb ............................. 0.07  irrelevante
 *   trocar equalpower por HRTF ............................... ~0.1  secundario
 *   disparos montados camada a camada, 600 rpm ............... 2.22  <-- estoura
 *
 * Ou seja: nao era vazamento de nos (o Chrome pula o que ja esta em silencio,
 * e o teste com 12 mil nos parados confirmou), nao era o reverb e nao era o
 * HRTF. Era a quantidade de nos SINTETIZANDO AO MESMO TEMPO. Cada tripla
 * (fonte + filtro + ganho) ativa custa ~0.005 do tempo real e um disparo
 * montado camada a camada tem ~18 nos, entao a conta passava de 1.0 com apenas
 * ~6 vozes — muito abaixo do que 12 hostis a 600 rpm produzem. Isso e o estalo.
 *
 * Com a forma de onda em cache, as mesmas 16 vozes na mesma cadencia custam
 * 0.29 em vez de 2.22, e 48 vozes ainda cabem em 0.68.
 *
 * Esses numeros sao RELATIVOS e so isso. Toda esta secao mede em
 * OfflineAudioContext, que renderiza em blocos grandes, sem prazo e sem dividir
 * a maquina com render 3D, fisica e IA — ela subestima o custo absoluto em ~6x
 * (ver o bloco dos tetos, mais abaixo). Serve para dizer que o cache e 7x mais
 * barato que montar camada a camada, que e do que se trata aqui. Nao serve para
 * dizer quantas vozes cabem; para isso, tools/audiovarre.mjs, dentro do jogo.
 *
 * Duas correcoes, nenhuma delas mexendo no timbre:
 *
 *  1. POOL DE VOZES. A cadeia espacial (duas entradas + passa-baixa + panner +
 *     dois envios) e criada uma vez e reusada para sempre. Antes cada evento
 *     montava e abandonava a sua — ~300 nos por segundo em combate.
 *
 *  2. CACHE DE FORMA DE ONDA. Os sons de alta cadencia (tiro, impacto, passo,
 *     cartucho) sao sintetizados UMA VEZ, camada por camada, dentro de um
 *     OfflineAudioContext, e o resultado fica guardado em AudioBuffer. Tocar
 *     passa a custar UM no em vez de dezoito. Continua 100% procedural — quem
 *     gera o buffer e exatamente o mesmo codigo de sintese, so que rodado antes
 *     em vez de durante. Nenhum arquivo de audio entra no projeto. Enquanto o
 *     render offline nao termina, o caminho ao vivo (camada a camada) atende
 *     normalmente, entao nunca ha silencio esperando cache.
 *
 * Quem ganha a voz quando falta: PRIORIDADE, nao ordem de chegada
 * ----------------------------------------------------------------
 * Barateado o som, os tetos de voz de antes (24 posicionadas) viraram o gargalo:
 * medido com tools/audiodiag.mjs, com 12 hostis 81% dos sons pedidos nunca
 * tocavam. E o pool era servido por ordem de chegada, entao QUAL 19% tocava era
 * sorteio — um passo a 40 m derrubava um tiro a 8 m so por ter chegado antes.
 *
 * Descarte por si so nao e defeito: 12 hostis a 600 rpm pedem umas 110 vozes
 * simultaneas, e tocar as 110 nao seria melhor, seria papa. O defeito era o
 * CRITERIO. Nenhum teto que caiba na thread de audio resolve isso; so o criterio
 * resolve.
 *
 * Agora todo pedido de voz carrega uma prioridade = base do tipo de evento
 * menos a distancia (tabela PRIO, abaixo). Com o pool cheio, o pedido novo
 * ROUBA a voz mais fraca em curso, desde que a supere por MARGEM_ROUBO; se nao
 * superar, e ele que e descartado. Descarte continua existindo — nenhum jogo
 * toca tudo — mas passou a cair sempre no som menos informativo.
 *
 * Roubar uma voz e cortar uma forma de onda no meio, e corte seco e clique.
 * Por isso cada cadeia tem DUAS entradas (A/B) somadas no mesmo mixer: o som
 * roubado desvanece em 8 ms pela entrada que ocupava enquanto o som novo ja
 * ataca, do primeiro milissegundo, pela outra — que esta limpa. Os nos do som
 * desvanecido so sao desconectados depois que a rampa termina (`v.lixo`).
 */
import * as THREE from 'three';

/* ------------------------------------------------------------------------ */
/* Receitas                                                                  */
/* ------------------------------------------------------------------------ */

/** Timbre por arma. Tudo em Hz/segundos. */
const ARMAS = {
  padrao: {
    ganho: 0.85, corpo0: 1500, corpo1: 170, corpoQ: 1.1, corpoDec: 0.22,
    trans: 1.0, transHP: 2600, thump: 96, thump1: 44, thumpDec: 0.16,
    mech: 3100, mechG: 0.30, cauda: 0.42, beco: 0.30, crack: 0.55,
  },
  fuzil: {
    ganho: 1.0, corpo0: 1900, corpo1: 150, corpoQ: 0.95, corpoDec: 0.26,
    trans: 1.15, transHP: 3000, thump: 104, thump1: 40, thumpDec: 0.19,
    mech: 3400, mechG: 0.34, cauda: 0.50, beco: 0.40, crack: 0.8,
  },
  smg: {
    ganho: 0.8, corpo0: 2300, corpo1: 260, corpoQ: 1.5, corpoDec: 0.15,
    trans: 1.0, transHP: 3400, thump: 130, thump1: 66, thumpDec: 0.10,
    mech: 4200, mechG: 0.42, cauda: 0.34, beco: 0.26, crack: 0.55,
  },
  pistola: {
    ganho: 0.68, corpo0: 1700, corpo1: 300, corpoQ: 1.8, corpoDec: 0.12,
    trans: 0.9, transHP: 3800, thump: 150, thump1: 80, thumpDec: 0.08,
    mech: 4800, mechG: 0.30, cauda: 0.26, beco: 0.20, crack: 0.35,
  },
  escopeta: {
    ganho: 1.05, corpo0: 1100, corpo1: 110, corpoQ: 0.8, corpoDec: 0.34,
    trans: 1.2, transHP: 2200, thump: 78, thump1: 34, thumpDec: 0.26,
    mech: 2400, mechG: 0.5, cauda: 0.58, beco: 0.46, crack: 0.2,
  },
};

/** Alias comuns vindos do PLAYER (nomes livres) -> familia de timbre. */
function familia(nome) {
  if (!nome) return 'fuzil';
  const n = String(nome).toLowerCase();
  if (/pist|glock|9mm|taurus|colt/.test(n)) return 'pistola';
  if (/smg|sub|mp5|uzi|mac|metralhadora de mao/.test(n)) return 'smg';
  if (/esp|shot|12|calibre/.test(n)) return 'escopeta';
  if (/fuzil|rifle|ar|ia2|ak|m4|g3|para/.test(n)) return 'fuzil';
  return 'fuzil';
}

/** Passo por superficie: bandas, duracoes e "molhado". */
const PASSOS = {
  concreto: { f: 1500, q: 1.1, dec: 0.075, hp: 260, click: 5200, clickG: 0.35, g: 0.55 },
  asfalto: { f: 1100, q: 1.0, dec: 0.085, hp: 200, click: 4200, clickG: 0.22, g: 0.5 },
  tijolo: { f: 1400, q: 1.2, dec: 0.07, hp: 260, click: 5000, clickG: 0.3, g: 0.5 },
  terra: { f: 520, q: 0.8, dec: 0.13, hp: 90, click: 2400, clickG: 0.1, g: 0.55 },
  madeira: { f: 720, q: 2.6, dec: 0.14, hp: 130, click: 3000, clickG: 0.3, g: 0.6, ring: 190 },
  metal: { f: 1900, q: 3.2, dec: 0.20, hp: 400, click: 6400, clickG: 0.5, g: 0.55, ring: 2450 },
  agua: { f: 900, q: 0.7, dec: 0.24, hp: 150, click: 3200, clickG: 0.15, g: 0.7, splash: true },
  folhagem: { f: 3400, q: 0.6, dec: 0.17, hp: 1800, click: 7000, clickG: 0.2, g: 0.42 },
  vidro: { f: 4200, q: 6.0, dec: 0.16, hp: 1200, click: 8200, clickG: 0.6, g: 0.5, ring: 5200 },
  carne: { f: 320, q: 0.7, dec: 0.10, hp: 60, click: 900, clickG: 0.1, g: 0.5 },
};

/** Impacto de bala por superficie. */
const IMPACTOS = {
  concreto: { f: 1700, q: 1.4, dec: 0.11, thump: 150, thumpG: 0.5, g: 0.9 },
  tijolo: { f: 1350, q: 1.2, dec: 0.13, thump: 130, thumpG: 0.55, g: 0.9 },
  asfalto: { f: 1200, q: 1.1, dec: 0.10, thump: 120, thumpG: 0.5, g: 0.85 },
  metal: { f: 2900, q: 5.0, dec: 0.26, thump: 320, thumpG: 0.3, g: 1.0, ricochete: 0.55, ring: 3400 },
  madeira: { f: 780, q: 2.2, dec: 0.14, thump: 160, thumpG: 0.45, g: 0.8, ring: 260 },
  vidro: { f: 5200, q: 7.0, dec: 0.30, thump: 0, thumpG: 0, g: 0.9, caco: true },
  terra: { f: 420, q: 0.7, dec: 0.10, thump: 90, thumpG: 0.7, g: 0.75 },
  agua: { f: 800, q: 0.8, dec: 0.22, thump: 70, thumpG: 0.4, g: 0.8, splash: true },
  folhagem: { f: 3600, q: 0.6, dec: 0.12, thump: 0, thumpG: 0, g: 0.5 },
  carne: { f: 380, q: 1.0, dec: 0.09, thump: 80, thumpG: 0.8, g: 0.95, molhado: true },
};

/* Tetos por tipo de cadeia. MEDIDOS, nao escolhidos — e medidos DENTRO DO JOGO.
 *
 * Aviso que custou uma rodada inteira: a bancada offline (tools/audioteto.mjs)
 * SUBESTIMA o custo em ~6x. OfflineAudioContext renderiza em blocos grandes, sem
 * prazo e sem disputar a maquina com render 3D, fisica e IA; a thread de audio de
 * verdade trabalha em quanta de 128 amostras com buffer de ~10 ms, onde o custo
 * FIXO por no domina. A bancada dizia "56 vozes = 0.25 de carga, folga de 4x"; o
 * jogo real com 56 vozes perdeu ~30% do audio. Offline serve para comparar
 * caminhos entre si, nunca para escolher teto.
 *
 * A medida que decide e a DERIVA entre o relogio de parede e o relogio de audio
 * (tools/audiovarre.mjs, 6 s por configuracao, tres passagens em ordens
 * rotacionadas, valendo o MINIMO de cada uma — a maquina esta disputada, e uma
 * medida alta pode ser lentidao alheia, mas uma medida baixa nao pode ser sorte:
 * ninguem entrega audio mais rapido que o proprio custo). Se o relogio de audio
 * anda menos que o de parede, a thread nao entregou buffer, e isso e o estalo:
 *
 *              |       8 hostis      |      12 hostis      |
 *   hrtf + eq  | total | deriva | desc | deriva | descarte |
 *      6 + 18  |    24 |   0 ms |  55% |   -9 ms |     68%   <- o teto antigo
 *     12 + 20  |    32 |   3 ms |  45% |   49 ms |     52%
 *     12 + 28  |    40 |   1 ms |  32% |    5 ms |     48%
 *      6 + 42  |    48 |   6 ms |  24% |      -  |       -
 *     16 + 32  |    48 |   7 ms |  21% |   33 ms |     44%   <- escolhido
 *     16 + 40  |    56 | 154 ms |  18% |  943 ms |     44%
 *     16 + 48  |    64 |     -  |   -  |  861 ms |     37%
 *
 * Ate 48 vozes posicionadas a thread de audio entrega tudo: deriva de dezenas de
 * milissegundos em 6 s, ou seja, meio por cento. Em 56 a deriva nao chega perto
 * de zero em passagem NENHUMA, nas duas cargas — e o joelho, e ele e um degrau,
 * nao uma rampa.
 *
 * E 56 nao compra nada: com 12 hostis o descarte fica nos mesmos 44% de 48. Dali
 * para cima o que sobra negado nao e falta de vaga, e som que perdeu a disputa
 * de prioridade — e para esse, cadeia a mais nao adianta. 48 nao e so o lado
 * seguro do joelho; e onde a curva para de pagar.
 *
 * As duas linhas de 48 respondem a segunda pergunta: 6 HRTF e 16 HRTF custam a
 * MESMA coisa (6 ms x 7 ms). O panner binaural nao e mais o no caro que se
 * pensava — o que custa e a cadeia existir e ter fonte tocando, com qualquer
 * modelo de panorama. Entao o pool binaural sobe de 6 para 16 e o raio sobe de
 * 14 para 20 m: direcao e informacao de combate e, aqui, e de graca.
 *
 * Como as cadeias sao permanentes, o modelo de panorama e escolhido na criacao e
 * nunca mais muda — trocar `panningModel` em tempo de execucao reinicializa o
 * banco de HRIR, que era caro e inutil. Quando um pool satura, o outro serve de
 * transbordo, entao o total de 48 e o que vale; a divisao so diz a preferencia. */
const MAX_HRTF = 16;      // vozes proximas, panorama binaural
const MAX_ESPACIAL = 32;  // demais vozes posicionadas
const MAX_PLANO = 14;     // vozes 2D: arma do jogador, recarga, HUD
const PERTO_HRTF = 20;    // metros abaixo dos quais vale gastar HRTF

/**
 * Prioridade base por tipo de evento. Maior ganha a voz.
 *
 * A regra que estas faixas existem para garantir: um passo de hostil a 40 m
 * NUNCA derruba um tiro a 8 m. Como a distancia desconta PRIO_DIST por metro e o
 * alcance maximo de um som posicionado e 85 m, o desconto vale no maximo ~42
 * pontos — entao a separacao entre familias (passo 48 x tiro 78) e maior que
 * qualquer inversao que a distancia possa produzir dentro do alcance util.
 *
 * Dentro de uma mesma familia quem decide e a distancia: entre dois passos, toca
 * o mais perto; entre dois tiros, idem. E exatamente o que o ouvido usa para se
 * situar.
 */
const PRIO = {
  danoJogador: 100,  // levar tiro e a informacao mais cara de perder
  /* Acima de tiroJogador por MARGEM_ROUBO inteira, e de proposito: o clique da
   * recarga tem de furar a propria rajada do jogador, que e justamente quando
   * ele precisa saber que a arma esta vazia. */
  contrato: 96,      // recarga, pente vazio, troca: retorno direto de acao
  tiroJogador: 88,   // a propria arma; 2D, nao disputa com o mundo
  aterrissagem: 84,
  tiro: 78,          // disparo de hostil — de onde vem o perigo
  morte: 72,
  alerta: 66,
  recargaHostil: 64, // hostil trocando pente perto: abertura, e informacao boa
  dor: 60,
  impacto: 56,       // bala batendo perto de voce, ou o seu acerto
  passo: 48,         // "tem maquina subindo a viela"
  cartucho: 22,
  ambiente: 12,      // cachorro, passaro, radio, tiroteio la longe
};
/** Desconto de prioridade por metro de distancia. */
const PRIO_DIST = 0.5;
/** Quanto o pedido novo precisa superar a voz mais fraca para roubar a vaga.
 *  Existe para nao virar troca-troca entre sons de peso equivalente. */
const MARGEM_ROUBO = 8;
/** Voz com menos que isto de som pela frente e reaproveitada sem cerimonia:
 *  o que resta dela e cauda inaudivel, entao nao ha roubo nenhum a discutir. */
const FIM_PROXIMO = 0.12;
/** Rampa de saida do som roubado. Curta o bastante para nao atrasar o som novo,
 *  longa o bastante para o corte nao virar clique. */
const FADE_ROUBO = 0.008;

/** Variantes pre-renderizadas por som. Mais de uma para nao soar de maquina. */
const VARIANTES = 4;

const _vAud = new THREE.Vector3();
const _vOuvinte = new THREE.Vector3();
const _vAudAlvo = new THREE.Vector3();
const _vDir = new THREE.Vector3();
const _vUp = new THREE.Vector3();
const _vTmp = new THREE.Vector3();

export class AudioEngine {
  /** @param {object} ctx GameContext */
  constructor(ctx) {
    this.ctx = ctx;
    this.actx = null;
    this.pronto = false;
    this.ligado = true;
    this.vozes = 0;
    this.tempo = 0;

    this.bufRuido = null;
    this._offs = [];
    this._proxLatido = 9 + Math.random() * 14;
    this._proxPassaro = 3 + Math.random() * 8;
    this._proxRadio = 6 + Math.random() * 10;
    this._proxTiroLonge = 20 + Math.random() * 40;
    this._duckAte = 0;
    this._tinnitusAte = 0;
    this._tiroRecente = 0;
    this._ultimoPasso = -1;
    this.pausable = false;    // o ambiente continua tocando no menu/pausa

    /* Pools de cadeias de voz. Nascem vazios e crescem sob demanda ate o teto;
     * depois disso ninguem mais aloca nada durante o jogo. */
    this._poolHrtf = [];
    this._poolEq = [];
    this._poolPlano = [];
    this._pools = [this._poolHrtf, this._poolEq, this._poolPlano];
    /* Tetos em campo de instancia, e nao so nas constantes: a varredura de
     * tools/audiovarre.mjs precisa mexer neles DENTRO do jogo rodando, que e o
     * unico lugar onde o custo real da thread de audio aparece. */
    this.tetos = { hrtf: MAX_HRTF, eq: MAX_ESPACIAL, plano: MAX_PLANO };
    /* Voz sendo montada agora. Os helpers (_ruido/_osc/_filtro/_ganho) penduram
     * nela os nos efemeros para que a reciclagem saiba o que desconectar. */
    this._vozAtual = null;
    this._reciclouEm = -1;
    this._roubos = 0;             // vagas tomadas de som ainda tocando
    this._reaproveitados = 0;     // vagas de som ja praticamente acabado

    this._bufs = new Map();       // chave -> AudioBuffer[] pronto para tocar
    this._renderizando = new Set();
  }

  /* -------------------------------------------------------------------- */
  /* Ciclo de vida                                                         */
  /* -------------------------------------------------------------------- */

  async init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { console.warn('[FX/audio] WebAudio indisponivel — som desligado.'); return this; }

    try {
      this.actx = new AC({ latencyHint: 'interactive' });
    } catch (e) {
      console.warn('[FX/audio] falhou ao criar AudioContext:', e);
      return this;
    }
    const a = this.actx;

    // --- barramentos ------------------------------------------------------
    this.limiter = a.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.0015;
    this.limiter.release.value = 0.09;
    this.limiter.connect(a.destination);

    this.master = a.createGain();
    this.master.gain.value = this.ctx.settings?.masterVolume ?? 0.8;
    this.master.connect(this.limiter);

    // "cola": compressor lento que junta as camadas e segura a rajada
    this.cola = a.createDynamicsCompressor();
    this.cola.threshold.value = -20;
    this.cola.knee.value = 14;
    this.cola.ratio.value = 3.2;
    this.cola.attack.value = 0.006;
    this.cola.release.value = 0.20;
    this.cola.connect(this.master);

    /* Ducking tem no PROPRIO.
     *
     * Antes `_duck` automatizava o mesmo AudioParam que o slider de efeitos e a
     * pausa — tres donos escrevendo no busSfx.gain, cada um com o seu
     * cancelScheduledValues. Um `cancel` no meio da rampa do outro produz salto
     * de ganho no barramento inteiro, que e clique audivel, e o jogador atirando
     * dispara isso dez vezes por segundo. Separado, cada automacao tem um dono
     * so e elas se multiplicam em vez de brigar. */
    this.duck = a.createGain();
    this.duck.gain.value = 1;
    this.duck.connect(this.cola);

    this.busSfx = a.createGain();
    this.busSfx.gain.value = this.ctx.settings?.sfxVolume ?? 1.0;
    this.busSfx.connect(this.duck);

    /* Ambiente entra DENTRO de efeitos, nao como barramento proprio.
     * Assim o jogador tem so tres controles — geral, efeitos e musica — e o
     * vento acompanha o slider de efeitos em vez de virar um quarto ajuste
     * escondido. O ganho aqui e so o nivel relativo do ambiente dentro da
     * mixagem de efeitos; quem manda no volume e o busSfx. */
    this.busAmb = a.createGain();
    this.busAmb.gain.value = 0.5;
    this.busAmb.connect(this.busSfx);

    this.busMus = a.createGain();
    this.busMus.gain.value = this.ctx.settings?.musicVolume ?? 0.35;
    this.busMus.connect(this.master);

    // --- reverbs ----------------------------------------------------------
    this.convRua = a.createConvolver();
    this.convRua.normalize = true;
    this.convRua.buffer = this._criaIR(1.35, 5.2, {
      taps: [[0.006, 0.62], [0.011, 0.48], [0.017, 0.4], [0.026, 0.3], [0.038, 0.22]],
      lp: 0.30, predelay: 0.004,
    });
    this.envioRua = a.createGain();
    this.envioRua.gain.value = 1;
    this.envioRua.connect(this.convRua);
    /* O retorno do reverb entra no busSfx, NAO direto no compressor.
     *
     * Antes so o sinal seco passava pelo controle de efeitos; a cauda ia por
     * fora. Zerar "Efeitos" calava o tiro mas deixava o eco tocando sozinho —
     * pior ainda, o eco ficava relativamente MAIS alto conforme se abaixava o
     * volume. Molhado e seco tem de andar juntos. */
    this.revRuaGain = a.createGain();
    this.revRuaGain.gain.value = 0.9;
    this.convRua.connect(this.revRuaGain).connect(this.busSfx);

    // beco: IR longa, escura, com flutter entre paredes paralelas
    this.convBeco = a.createConvolver();
    this.convBeco.normalize = true;
    this.convBeco.buffer = this._criaIR(2.9, 2.1, {
      taps: [[0.031, 0.55], [0.062, 0.44], [0.094, 0.36], [0.127, 0.3],
      [0.161, 0.24], [0.198, 0.2], [0.243, 0.16], [0.301, 0.12]],
      lp: 0.085, predelay: 0.028,
    });
    this.envioBeco = a.createGain();
    this.envioBeco.gain.value = 1;
    const becoLP = a.createBiquadFilter();
    becoLP.type = 'lowpass'; becoLP.frequency.value = 1500; becoLP.Q.value = 0.4;
    this.envioBeco.connect(this.convBeco).connect(becoLP);
    this.revBecoGain = a.createGain();
    this.revBecoGain.gain.value = 0.75;
    becoLP.connect(this.revBecoGain).connect(this.busSfx);

    // --- ruido base -------------------------------------------------------
    this.bufRuido = this._criaRuido(2.0);
    this._offs = [];

    // --- listener ---------------------------------------------------------
    const L = a.listener;
    this._listenerParam = !!L.positionX;
    if (!this._listenerParam && L.setPosition) L.setPosition(0, 1.68, 0);

    this._montaAmbiente();
    this._assina();
    this._instalaGesto();

    this.pronto = true;
    return this;
  }

  /** Retoma o contexto (precisa de gesto do usuario). */
  resume() {
    if (!this.actx) return Promise.resolve(false);
    if (this.actx.state === 'running') return Promise.resolve(true);
    return this.actx.resume().then(() => {
      this._ambienteLigado();
      return true;
    }).catch(() => false);
  }

  _instalaGesto() {
    const ativa = () => { this.resume(); };
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
      window.addEventListener(ev, ativa, { passive: true });
    }
    this._removeGesto = () => {
      for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
        window.removeEventListener(ev, ativa);
      }
    };
  }

  get ativo() {
    return this.pronto && this.ligado && this.actx && this.actx.state === 'running';
  }

  /* -------------------------------------------------------------------- */
  /* Geracao de buffers                                                    */
  /* -------------------------------------------------------------------- */

  /**
   * @param {number} seg    duracao do buffer
   * @param {number} canais 2 para o ruido do ambiente (largura), 1 para os
   *   pre-renders posicionados — fonte pontual e mono, e somar dois canais
   *   descorrelacionados para virar mono custaria 3 dB de nivel a toa.
   */
  _criaRuido(seg, canais = 2) {
    const a = this.actx;
    const n = Math.floor(a.sampleRate * seg);
    const buf = a.createBuffer(canais, n, a.sampleRate);
    for (let c = 0; c < canais; c++) {
      const d = buf.getChannelData(c);
      // ruido branco levemente correlacionado (soa menos "chiado digital")
      let ant = 0;
      for (let i = 0; i < n; i++) {
        const b = Math.random() * 2 - 1;
        ant = ant * 0.12 + b * 0.88;
        d[i] = ant;
      }
    }
    return buf;
  }

  /**
   * Impulso de reverberacao gerado do zero: ruido com decaimento exponencial,
   * reflexoes iniciais discretas e absorcao (passa-baixa de 1 polo).
   */
  _criaIR(dur, decai, o = {}) {
    const a = this.actx;
    const sr = a.sampleRate;
    const pre = Math.floor((o.predelay ?? 0) * sr);
    const n = Math.floor(dur * sr) + pre;
    const buf = a.createBuffer(2, n, sr);
    const lp = o.lp ?? 0.25;
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = pre; i < n; i++) {
        const t = (i - pre) / sr;
        // acumulacao de densidade: comeca esparso e adensa (difusao real)
        const dens = Math.min(1, t * 24);
        const env = Math.exp(-decai * t) * dens;
        d[i] = (Math.random() * 2 - 1) * env;
      }
      // reflexoes iniciais, com polaridade alternada entre canais
      for (const [tt, gg] of (o.taps || [])) {
        const i = pre + Math.floor(tt * sr * (c === 0 ? 1 : 1.06));
        if (i < n) d[i] += gg * (c === 0 ? 1 : -0.85);
      }
      // absorcao
      let y = 0;
      for (let i = 0; i < n; i++) { y += lp * (d[i] - y); d[i] = y; }
      // normaliza para nao estourar o convolver
      let pico = 0;
      for (let i = 0; i < n; i++) pico = Math.max(pico, Math.abs(d[i]));
      if (pico > 0) { const k = 0.9 / pico; for (let i = 0; i < n; i++) d[i] *= k; }
    }
    return buf;
  }

  /* -------------------------------------------------------------------- */
  /* Infra de vozes                                                        */
  /* -------------------------------------------------------------------- */

  /**
   * Registra um no efemero na voz que esta sendo montada.
   *
   * Sem isso o no fica pendurado na entrada da cadeia para sempre: quando a voz
   * fosse reusada por outro som, o lixo da voz anterior voltaria a tocar junto.
   */
  _reg(no) {
    const v = this._vozAtual;
    if (v) v.ef[v.i].push(no);
    return no;
  }

  /**
   * Anuncia que a voz corrente ainda produz som ate `t` (relogio de audio).
   *
   * A vida da voz passa a ser o fim REAL da ultima camada, e nao um palpite:
   * antes um disparo reservava 1,6 s de orcamento para 0,4 s de som, e o teto
   * de vozes vivia estourado a toa, derrubando sons que caberiam.
   */
  _marcaFim(t) {
    const v = this._vozAtual;
    if (!v || !Number.isFinite(t)) return;
    if (t > v.ate) v.ate = Math.min(t, v.limite);
  }

  /** Fonte de ruido reutilizando o buffer pre-gerado (offset aleatorio). */
  _ruido(t0, dur, taxa = 1) {
    const s = this.actx.createBufferSource();
    s.buffer = this.bufRuido;
    s.loop = true;
    s.playbackRate.value = taxa;
    const off = Math.random() * (this.bufRuido.duration - 0.05);
    s.start(t0, off, dur);
    this._marcaFim(t0 + dur + 0.03);
    return this._reg(s);
  }

  /** Envelope percussivo com ataque em `atk` e queda exponencial em `dec`. */
  _env(param, t0, pico, atk, dec, curva = 1) {
    param.cancelScheduledValues(t0);
    param.setValueAtTime(0.0001, t0);
    if (atk <= 0.0005) param.setValueAtTime(Math.max(0.0002, pico), t0 + 0.0005);
    else param.exponentialRampToValueAtTime(Math.max(0.0002, pico), t0 + atk);
    param.exponentialRampToValueAtTime(0.0001, t0 + atk + dec * curva);
  }

  /**
   * Monta UMA VEZ a cadeia permanente de uma voz.
   * `tipo`: 'hrtf' | 'eq' | 'plano'.
   */
  _criaCadeia(tipo) {
    const a = this.actx;
    const v = {
      tipo, ativa: false, ate: 0, limite: 0, prio: -Infinity,
      /* DUAS entradas somadas no mesmo mixer, e nao uma.
       *
       * Roubo de voz precisa cortar o som antigo com rampa (corte seco = clique)
       * e, ao mesmo tempo, deixar o som novo atacar do primeiro milissegundo (o
       * transiente de 1 ms E o tiro; silenciar 8 ms dele mataria o chicote). As
       * duas coisas nao cabem no mesmo AudioParam. Com A/B, o som velho some
       * pela entrada que ja ocupava enquanto o novo entra pela outra, limpa. */
      ent: [a.createGain(), a.createGain()],
      ef: [[], []],       // nos efemeros pendurados em cada entrada
      lixo: [null, null], // nos de uma entrada que ainda esta desvanecendo
      i: 0,               // entrada em uso
    };
    v.ent[0].gain.value = 0;
    v.ent[1].gain.value = 0;

    /* A segunda entrada nao adicionou no nenhum a cadeia espacial: as duas
     * entram direto no passa-baixa (WebAudio soma varias saidas num mesmo
     * destino), e a atenuacao por oclusao, que era um ganho proprio, virou fator
     * do ganho da entrada — ambos sao constantes durante um som. Cadeia
     * posicionada continua com seis nos, exatamente como antes do roubo de voz
     * existir; medir teto com a cadeia mais gorda teria viciado o resultado. */
    if (tipo === 'plano') {
      v.mix = a.createGain();
      v.ent[0].connect(v.mix);
      v.ent[1].connect(v.mix);
      v.saida = v.mix;
    } else {
      v.lp = a.createBiquadFilter();
      v.lp.type = 'lowpass'; v.lp.Q.value = 0.2; v.lp.frequency.value = 21000;
      v.pan = a.createPanner();
      v.pan.panningModel = (tipo === 'hrtf') ? 'HRTF' : 'equalpower';
      v.pan.distanceModel = 'inverse';
      v.pan.refDistance = 2.2;
      v.pan.rolloffFactor = 1.15;
      v.pan.maxDistance = 260;
      v.ent[0].connect(v.lp);
      v.ent[1].connect(v.lp);
      v.lp.connect(v.pan);
      v.saida = v.pan;
    }

    // envios de reverb: ganho zero quando a voz esta livre
    v.gRua = a.createGain(); v.gRua.gain.value = 0;
    v.gBeco = a.createGain(); v.gBeco.gain.value = 0;
    v.gRua.connect(this.envioRua);
    v.gBeco.connect(this.envioBeco);
    v.saida.connect(this.busSfx);
    v.saida.connect(v.gRua);
    v.saida.connect(v.gBeco);
    return v;
  }

  _pool(tipo) {
    return tipo === 'hrtf' ? this._poolHrtf : tipo === 'eq' ? this._poolEq : this._poolPlano;
  }

  /** Cadeia livre no pool, ou uma nova se o teto ainda permite. */
  _livre(tipo) {
    const pool = this._pool(tipo);
    for (let i = 0; i < pool.length; i++) if (!pool[i].ativa) return pool[i];
    if (pool.length < this.tetos[tipo]) { const v = this._criaCadeia(tipo); pool.push(v); return v; }
    return null;
  }

  /**
   * Pool cheio: tenta tomar a vaga da voz mais fraca.
   *
   * Duas situacoes distintas, nesta ordem:
   *   1. voz a menos de FIM_PROXIMO do fim — o que resta dela e cauda inaudivel.
   *      Nao ha roubo a discutir: reaproveita e pronto, sem rampa e sem exigir
   *      prioridade nenhuma. E de graca, e recusar isso e so jogar som fora.
   *   2. voz com som pela frente — so cai se o pedido novo a superar por
   *      MARGEM_ROUBO, e ai sai com rampa de FADE_ROUBO.
   */
  _rouba(tipo, prio) {
    const pool = this._pool(tipo);
    const t = this.actx.currentTime;
    let fraca = null;
    for (let i = 0; i < pool.length; i++) {
      const v = pool[i];
      if (!v.ativa) continue;
      if (v.ate - t <= FIM_PROXIMO) { this._reaproveitados++; this._liberaVoz(v); return v; }
      /* Entrada alternativa ainda ocupada por um desvanecimento anterior: roubar
       * de novo agora obrigaria a cortar aquela rampa no meio — o clique que o
       * A/B existe para evitar. Deixa esta voz de fora desta rodada.
       * (Nao vale para o caso acima: aquele nao desvanece nada, so recolhe uma
       * voz que ja terminou, e para isso a outra entrada e irrelevante.) */
      if (v.lixo[v.i ^ 1]) continue;
      if (!fraca || v.prio < fraca.prio) fraca = v;
    }
    if (!fraca || prio < fraca.prio + MARGEM_ROUBO) return null;
    this._roubos++;
    this._desvanece(fraca);
    return fraca;
  }

  /**
   * Devolve uma cadeia para um pedido de prioridade `prio`.
   *
   * O pool de HRTF e o de equalpower sao transbordo um do outro: som perto
   * prefere binaural e som longe prefere equalpower, mas nenhum dos dois fica
   * sem tocar so porque o pool da sua preferencia encheu enquanto o outro tinha
   * cadeia parada. Roubo so entra depois de esgotado o que esta livre nos dois.
   */
  _pegaVoz(tipo, prio) {
    const alt = tipo === 'hrtf' ? 'eq' : tipo === 'eq' ? 'hrtf' : null;
    let v = this._livre(tipo);
    if (!v && alt) v = this._livre(alt);
    if (!v) v = this._rouba(tipo, prio);
    if (!v && alt) v = this._rouba(alt, prio);
    return v;
  }

  /** Solta a cadeia: desconecta o lixo do som que acabou e zera os ganhos. */
  _liberaVoz(v) {
    if (!v.ativa) return;
    const ef = v.ef[v.i];
    for (let i = 0; i < ef.length; i++) { try { ef[i].disconnect(); } catch { /* ja solto */ } }
    ef.length = 0;
    const t = this.actx.currentTime;
    v.ent[v.i].gain.cancelScheduledValues(t);
    v.ent[v.i].gain.value = 0;
    v.gRua.gain.value = 0;
    v.gBeco.gain.value = 0;
    v.ativa = false;
    v.prio = -Infinity;
    this.vozes = Math.max(0, this.vozes - 1);
    if (this._vozAtual === v) this._vozAtual = null;
  }

  /**
   * Tira o som que ocupa a voz SEM corta-lo seco: rampa de FADE_ROUBO ate zero
   * na entrada que ele usa, troca a entrada em uso e adia a desconexao dos nos
   * para depois da rampa. A voz ja volta livre para quem a roubou.
   */
  _desvanece(v) {
    const t = this.actx.currentTime;
    const g = v.ent[v.i].gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + FADE_ROUBO);
    v.lixo[v.i] = { nos: v.ef[v.i], ate: t + FADE_ROUBO + 0.004 };
    v.ef[v.i] = [];
    v.i ^= 1;
    v.ativa = false;
    v.prio = -Infinity;
    this.vozes = Math.max(0, this.vozes - 1);
    if (this._vozAtual === v) this._vozAtual = null;
  }

  /** Desconecta os nos de um desvanecimento ja terminado. */
  _varreLixo(v, k, t) {
    const lx = v.lixo[k];
    if (!lx || t < lx.ate) return;
    for (let i = 0; i < lx.nos.length; i++) { try { lx.nos[i].disconnect(); } catch { /* ja solto */ } }
    v.lixo[k] = null;
  }

  /**
   * Recicla as vozes cujo som ja terminou.
   *
   * Roda no RELOGIO DE AUDIO, nao em setTimeout. O contador antigo era
   * decrementado por temporizador de main thread: sob carga (que e exatamente
   * quando importa) o temporizador atrasa, o contador trava alto e o teto passa
   * a derrubar som que caberia — o oposto do que deveria fazer.
   *
   * Sai cedo se ja rodou neste mesmo instante do relogio de audio: em combate
   * `_voz` e chamado centenas de vezes por segundo e varrer ~70 cadeias em cada
   * chamada seria trabalho repetido — `currentTime` so anda de bloco em bloco.
   */
  _reciclaVozes() {
    const t = this.actx.currentTime;
    if (t === this._reciclouEm) return;
    this._reciclouEm = t;
    for (let p = 0; p < this._pools.length; p++) {
      const pool = this._pools[p];
      for (let i = 0; i < pool.length; i++) {
        const v = pool[i];
        if (v.ativa && t >= v.ate) this._liberaVoz(v);
        if (v.lixo[0]) this._varreLixo(v, 0, t);
        if (v.lixo[1]) this._varreLixo(v, 1, t);
      }
    }
  }

  /**
   * Reserva uma voz do pool, ja configurada, e devolve o no de ENTRADA.
   * @param {THREE.Vector3|null} pos posicao no mundo (null = 2D, na cabeca)
   * @param {object} o { cauda, beco, ganho, oclusao, alcance, vida, prio }
   */
  _voz(pos, o = {}) {
    this._vozAtual = null;
    if (!this.ativo) return null;
    this._reciclaVozes();
    const a = this.actx;

    /* `pos` precisa ser um Vector3 de verdade E com valores finitos.
     *
     * Eventos do bus as vezes trazem um objeto simples {x,y,z}, e chamar
     * distanceTo nele lancava. Pior: um Vector3 com NaN passa nesse teste, e o
     * NaN so aparece la embaixo virando frequencia de filtro — a WebAudio
     * recusa AudioParam nao-finito e derruba o handler inteiro. Sem posicao
     * valida, tocamos o som sem espacializacao em vez de perder o evento. */
    if (pos) {
      if (typeof pos.distanceTo !== 'function') {
        pos = (typeof pos.x === 'number') ? _vAudAlvo.set(pos.x, pos.y ?? 0, pos.z ?? 0) : null;
      }
      if (pos && !Number.isFinite(pos.x + pos.y + pos.z)) pos = null;
    }

    /* Corte por distancia ANTES de ocupar uma voz.
     *
     * Som a 100 m sai inaudivel depois da atenuacao, mas ocuparia uma cadeia e
     * uma fatia do orcamento de sintese. Melhor nem tocar. */
    const ouvinte = this.ctx.camera ? this.ctx.camera.position : _vOuvinte.set(0, 1.68, 0);
    let dist = 0;
    if (pos) {
      dist = pos.distanceTo(ouvinte);
      if (dist > (o.alcance ?? 85)) return null;
    }

    /* Prioridade do pedido = peso do tipo de evento menos a distancia.
     *
     * O pool nao e mais servido por ordem de chegada. Quem chega e mais forte
     * que a voz mais fraca em curso toma o lugar dela; quem chega mais fraco e
     * quem e descartado. E a diferenca entre "o mixer sorteia o que voce ouve" e
     * "o mixer guarda a informacao e joga fora o enfeite". */
    const prio = (o.prio ?? PRIO.ambiente) - PRIO_DIST * dist;

    /* HRTF so perto, e num pool proprio.
     *
     * HRTF convolve cada voz com uma resposta de impulso de cabeca: continua
     * sendo o no mais caro do grafo, ainda que a medicao tenha mostrado que nao
     * era ele o culpado pelo estalo. Como as cadeias agora sao permanentes, o
     * modelo e fixado na criacao: som perto prefere uma cadeia binaural e som
     * longe prefere equalpower, com transbordo de um pool para o outro. */
    const tipo = !pos ? 'plano' : (dist < PERTO_HRTF ? 'hrtf' : 'eq');
    const v = this._pegaVoz(tipo, prio);
    if (!v) return null;

    /* A oclusao so e calculada DEPOIS de a voz estar garantida: e um raycast de
     * BVH por som, e em combate a maioria dos pedidos e recusada. Pagar o
     * raycast para descobrir em seguida que nao ha voz e trabalho jogado fora na
     * main thread, justamente no quadro mais apertado. */
    let corteFinal = 21000, atenuaFinal = 1;
    if (pos) {
      // --- distancia + oclusao -> passa-baixa --------------------------------
      let corte = 21000 * Math.exp(-dist / 55) + 700;
      let atenua = 1;

      if (o.oclusao !== false && dist > 2.5) {
        const col = this.ctx.world?.collision;
        if (col?.built) {
          _vDir.copy(ouvinte).sub(pos);
          const d = _vDir.length();
          if (d > 0.01) {
            _vDir.multiplyScalar(1 / d);
            _vTmp.copy(pos).addScaledVector(_vDir, 0.25);
            const r = col.raycast(_vTmp, _vDir, d - 0.4);
            if (r.hit) {
              // parede no caminho: perde agudo e volume
              corte = Math.min(corte, 620);
              atenua = 0.45;
              // segunda parede? escurece mais (som dobrando esquina)
              _vTmp.copy(r.point).addScaledVector(_vDir, 0.35);
              const r2 = col.raycast(_vTmp, _vDir, Math.max(0.1, d - r.distance - 0.7));
              if (r2.hit) { corte = 320; atenua = 0.28; }
            }
          }
        }
      }

      // Cinto de seguranca: qualquer AudioParam nao-finito derruba o handler.
      if (!Number.isFinite(corte)) corte = 21000;
      if (!Number.isFinite(atenua)) atenua = 1;
      corteFinal = Math.max(180, Math.min(21000, corte));
      atenuaFinal = Math.max(0, Math.min(1, atenua));
    }

    const agora = a.currentTime;
    // cinto de seguranca: a entrada que vai receber o som novo tem de estar
    // limpa. `_rouba` ja recusa voz cuja entrada alternativa ainda desvanece.
    if (v.lixo[v.i]) this._varreLixo(v, v.i, Infinity);
    const ent = v.ent[v.i];
    v.ativa = true;
    v.prio = prio;
    v.ate = agora + 0.05;                             // piso; _marcaFim estende
    v.limite = agora + Math.max(1.0, (o.vida ?? 1.2) + 1.0);   // teto de seguranca
    ent.gain.cancelScheduledValues(agora);
    // a atenuacao de oclusao entra como fator do ganho da entrada, em vez de ter
    // um no proprio: as duas sao constantes durante o som
    ent.gain.value = (o.ganho ?? 1) * atenuaFinal;
    v.gRua.gain.value = o.cauda > 0 ? o.cauda : 0;
    v.gBeco.gain.value = o.beco > 0 ? o.beco : 0;

    if (pos) {
      v.lp.frequency.value = corteFinal;
      if (v.pan.positionX) {
        v.pan.positionX.value = pos.x; v.pan.positionY.value = pos.y; v.pan.positionZ.value = pos.z;
      } else if (v.pan.setPosition) v.pan.setPosition(pos.x, pos.y, pos.z);
    }

    this.vozes++;
    this._vozAtual = v;
    return ent;
  }

  /* -------------------------------------------------------------------- */
  /* Cache de forma de onda                                                */
  /* -------------------------------------------------------------------- */

  /**
   * Toca um som ja pre-renderizado — UM no em vez da pilha de camadas.
   *
   * Se o buffer ainda nao existe, dispara o render offline e devolve false para
   * que o chamador sintetize ao vivo desta vez. Assim nada fica mudo esperando
   * cache e o caminho ao vivo continua sendo a referencia do timbre.
   *
   * @param {string} chave  identidade do som (arma, superficie, etc.)
   * @param {AudioNode} ent entrada da voz
   * @param {number} t0     instante de disparo
   * @param {number} dur    duracao a reservar no render offline
   * @param {number} canais 1 = mono (vai para o panner), 2 = estereo (2D)
   * @param {Function} monta funcao que monta as camadas em qualquer contexto
   * @returns {boolean} true se tocou do cache
   */
  _tocaCache(chave, ent, t0, dur, canais, monta) {
    const bufs = this._bufs.get(chave);
    if (!bufs) { this._preRenderiza(chave, dur, canais, monta); return false; }
    const s = this.actx.createBufferSource();
    s.buffer = bufs[(Math.random() * bufs.length) | 0];
    // leve variacao de tom: sem isso a rajada soa recortada e colada
    s.playbackRate.value = 0.97 + Math.random() * 0.06;
    s.connect(ent);
    s.start(t0);
    this._marcaFim(t0 + s.buffer.duration / s.playbackRate.value + 0.03);
    this._reg(s);
    return true;
  }

  /**
   * Sintetiza `VARIANTES` versoes do som num OfflineAudioContext e guarda.
   *
   * Continua 100% procedural: quem gera o buffer e o MESMO codigo de camadas do
   * caminho ao vivo, rodado num contexto offline. `Object.create(this)` herda
   * todos os helpers e so troca o contexto de audio embaixo deles.
   */
  _preRenderiza(chave, dur, canais, monta) {
    if (this._renderizando.has(chave) || !this.actx) return;
    if (typeof OfflineAudioContext === 'undefined') return;
    this._renderizando.add(chave);
    const sr = this.actx.sampleRate;
    const n = Math.max(1, Math.ceil(dur * sr));
    const tarefas = [];
    for (let i = 0; i < VARIANTES; i++) {
      let oc;
      try { oc = new OfflineAudioContext(canais, n, sr); }
      catch { this._renderizando.delete(chave); return; }
      const eu = Object.create(this);
      eu.actx = oc;
      // ruido curto: `_ruido` entra em offset aleatorio e faz loop, entao o que
      // importa e ter material suficiente para a camada mais longa
      eu.bufRuido = this._criaRuido.call(eu, Math.max(0.6, dur + 0.2), canais);
      eu._vozAtual = null;          // offline nao tem voz: nada a registrar
      const alvo = oc.createGain();
      alvo.gain.value = 1;
      alvo.connect(oc.destination);
      try { monta.call(eu, alvo, 0.002); }
      catch { this._renderizando.delete(chave); return; }
      tarefas.push(oc.startRendering());
    }
    Promise.all(tarefas)
      .then((bufs) => { this._bufs.set(chave, bufs); })
      .catch(() => { /* sem cache: o caminho ao vivo continua atendendo */ })
      .finally(() => { this._renderizando.delete(chave); });
  }

  /** Oscilador com varredura de tom. */
  _osc(tipo, t0, f0, f1, dur, curvaExp = true) {
    const o = this.actx.createOscillator();
    o.type = tipo;
    o.frequency.setValueAtTime(f0, t0);
    if (curvaExp) o.frequency.exponentialRampToValueAtTime(Math.max(8, f1), t0 + dur);
    else o.frequency.linearRampToValueAtTime(Math.max(8, f1), t0 + dur);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
    this._marcaFim(t0 + dur + 0.05);
    return this._reg(o);
  }

  _filtro(tipo, f, q) {
    const b = this.actx.createBiquadFilter();
    b.type = tipo; b.frequency.value = f; b.Q.value = q ?? 1;
    return this._reg(b);
  }

  _ganho(v = 1) { const g = this.actx.createGain(); g.gain.value = v; return this._reg(g); }

  /* -------------------------------------------------------------------- */
  /* Sons do jogo                                                          */
  /* -------------------------------------------------------------------- */

  /**
   * Disparo. `perto` = disparo do proprio jogador (ganha peso, zumbido e duck).
   * @param {string} arma
   * @param {THREE.Vector3|null} pos
   * @param {boolean} perto
   */
  tiro(arma, pos, perto = false) {
    if (!this.ativo) return;
    const fam = familia(arma);
    const P = ARMAS[fam] || ARMAS.padrao;
    const t0 = this.actx.currentTime + 0.001;

    const ent = this._voz(perto ? null : pos, {
      cauda: P.cauda, beco: P.beco, ganho: P.ganho * (perto ? 0.95 : 1.0), vida: 0.8,
      prio: perto ? PRIO.tiroJogador : PRIO.tiro,
    });
    if (!ent) return;

    /* Caminho rapido: forma de onda ja pronta = 1 no.
     * O disparo e o som de maior cadencia do jogo (600 rpm por hostil) e o que
     * mais camadas tem; e aqui que o cache paga. */
    const chave = `tiro:${fam}:${perto ? 'p' : 'l'}`;
    const canais = perto ? 2 : 1;   // 2D mantem a largura; posicionado vai ao panner
    /* Funcao COMUM, nao arrow: `_preRenderiza` a chama com `this` trocado por um
     * clone do motor apontando para o contexto offline. Uma arrow ignoraria essa
     * troca e sintetizaria no contexto ao vivo — som duplicado e cache vazio. */
    if (!this._tocaCache(chave, ent, t0, 0.6, canais, function (alvo, td) {
      this._camadasTiro(alvo, td, P, perto);
    })) {
      this._camadasTiro(ent, t0, P, perto);
    }

    if (perto) {
      this._tiroRecente = Math.min(1.6, this._tiroRecente + 0.28);
      this._duck(0.42, 0.13);
    }
  }

  /** Receita de timbre de uma arma. Existe para os testes de tools/. */
  _receita(arma) { return ARMAS[familia(arma)] || ARMAS.padrao; }

  /**
   * As quatro camadas do disparo mais o crack supersonico.
   *
   * Escrito para rodar em QUALQUER contexto: ao vivo, direto na voz, ou dentro
   * de um OfflineAudioContext para virar cache. Por isso so usa `this.actx` e os
   * helpers — nada aqui olha para o pool nem para o relogio do jogo.
   */
  _camadasTiro(ent, t0, P, perto) {
    const v = Math.pow(2, (Math.random() - 0.5) * 0.12);   // variacao de timbre

    // 1) transiente — o estalo. Ataque de 1 ms e o que da "chicote".
    {
      const s = this._ruido(t0, 0.09, 1.0 + Math.random() * 0.15);
      const hp = this._filtro('highpass', P.transHP * v, 0.7);
      const g = this._ganho(0);
      this._env(g.gain, t0, P.trans * 0.9, 0.0009, 0.055);
      s.connect(hp).connect(g).connect(ent);
    }
    // 2) corpo — ruido em banda com varredura descendente
    {
      const s = this._ruido(t0, P.corpoDec + 0.12, 1.0);
      const bp = this._filtro('bandpass', P.corpo0 * v, P.corpoQ);
      bp.frequency.setValueAtTime(P.corpo0 * v, t0);
      bp.frequency.exponentialRampToValueAtTime(P.corpo1 * v, t0 + P.corpoDec * 0.85);
      const lp = this._filtro('lowpass', 6500, 0.5);
      const g = this._ganho(0);
      this._env(g.gain, t0, 1.05, 0.004, P.corpoDec);
      s.connect(bp).connect(lp).connect(g).connect(ent);
    }
    // 3) thump — o peso no peito
    {
      const o = this._osc('sine', t0, P.thump * v, P.thump1, P.thumpDec);
      const g = this._ganho(0);
      this._env(g.gain, t0, 0.85, 0.002, P.thumpDec);
      o.connect(g).connect(ent);
      // um pouco de distorcao harmonica: 2a ordem fraca
      const o2 = this._osc('triangle', t0, P.thump * 2 * v, P.thump1 * 2, P.thumpDec * 0.6);
      const g2 = this._ganho(0);
      this._env(g2.gain, t0, 0.22, 0.002, P.thumpDec * 0.6);
      o2.connect(g2).connect(ent);
    }
    // 4) mecanica do ferrolho, atrasada
    {
      const td = t0 + 0.011 + Math.random() * 0.006;
      const s = this._ruido(td, 0.05, 1.0);
      const bp = this._filtro('bandpass', P.mech * v, 7);
      const g = this._ganho(0);
      this._env(g.gain, td, P.mechG, 0.0012, 0.032);
      s.connect(bp).connect(g).connect(ent);
    }
    // 5) crack supersonico (so audivel de fora / a distancia)
    if (P.crack > 0 && !perto) {
      const s = this._ruido(t0 + 0.002, 0.03, 1.2);
      const hp = this._filtro('highpass', 4200, 0.9);
      const g = this._ganho(0);
      this._env(g.gain, t0 + 0.002, P.crack * 0.5, 0.0008, 0.02);
      s.connect(hp).connect(g).connect(ent);
    }
  }

  /** Impacto de projetil numa superficie. */
  impacto(superficie, pos) {
    if (!this.ativo) return;
    const chaveSup = IMPACTOS[superficie] ? superficie : 'concreto';
    const S = IMPACTOS[chaveSup];
    const t0 = this.actx.currentTime + 0.001;

    const ent = this._voz(pos, { cauda: 0.16, beco: 0.12, ganho: S.g * 0.62, vida: 0.8, prio: PRIO.impacto });
    if (!ent) return;

    if (this._tocaCache(`imp:${chaveSup}`, ent, t0, 0.7, 1, function (alvo, td) {
      this._camadasImpacto(alvo, td, S);
    })) return;

    this._camadasImpacto(ent, t0, S);
  }

  /** Camadas do impacto. Roda ao vivo ou offline (ver `_camadasTiro`). */
  _camadasImpacto(ent, t0, S) {
    const v = Math.pow(2, (Math.random() - 0.5) * 0.35);

    // corpo do estalo
    {
      const s = this._ruido(t0, S.dec + 0.06, 1.0);
      const bp = this._filtro('bandpass', S.f * v, S.q);
      bp.frequency.setValueAtTime(S.f * v, t0);
      bp.frequency.exponentialRampToValueAtTime(S.f * v * 0.45, t0 + S.dec);
      const g = this._ganho(0);
      this._env(g.gain, t0, 1.0, 0.0009, S.dec);
      s.connect(bp).connect(g).connect(ent);
    }
    // thump grave (massa do material)
    if (S.thumpG > 0) {
      const o = this._osc('sine', t0, S.thump * v, S.thump * 0.55, 0.09);
      const g = this._ganho(0);
      this._env(g.gain, t0, S.thumpG, 0.002, 0.085);
      o.connect(g).connect(ent);
    }
    // ressonancia metalica / madeira oca
    if (S.ring) {
      const o = this._osc('sine', t0, S.ring * v, S.ring * v * 0.9, 0.32);
      const g = this._ganho(0);
      this._env(g.gain, t0, 0.30, 0.001, 0.3);
      o.connect(g).connect(ent);
    }
    // ricochete: assobio descendente saindo pela lateral
    if (S.ricochete && Math.random() < S.ricochete) {
      const td = t0 + 0.012;
      const dur = 0.28 + Math.random() * 0.3;
      const o = this._osc('sine', td, 2600 + Math.random() * 1600, 500 + Math.random() * 400, dur);
      const bp = this._filtro('bandpass', 2200, 3);
      const g = this._ganho(0);
      this._env(g.gain, td, 0.36, 0.006, dur);
      o.connect(bp).connect(g).connect(ent);
      // um pouco de ruido junto: o assobio puro soa sintetico demais
      const s = this._ruido(td, dur, 1.0);
      const bp2 = this._filtro('bandpass', 3000, 1.5);
      bp2.frequency.setValueAtTime(3000, td);
      bp2.frequency.exponentialRampToValueAtTime(700, td + dur);
      const g2 = this._ganho(0);
      this._env(g2.gain, td, 0.14, 0.006, dur);
      s.connect(bp2).connect(g2).connect(ent);
    }
    // cacos de vidro caindo
    if (S.caco) {
      for (let i = 0; i < 5; i++) {
        const td = t0 + 0.03 + Math.random() * 0.42;
        const f = 3200 + Math.random() * 5200;
        const o = this._osc('sine', td, f, f * 0.82, 0.09);
        const g = this._ganho(0);
        this._env(g.gain, td, 0.10 + Math.random() * 0.1, 0.001, 0.08);
        o.connect(g).connect(ent);
      }
    }
    // agua: subida de tom (bolha)
    if (S.splash) {
      const o = this._osc('sine', t0, 260, 1400, 0.13);
      const g = this._ganho(0);
      this._env(g.gain, t0, 0.28, 0.004, 0.12);
      o.connect(g).connect(ent);
    }
    // carne: componente molhada, curta e escura
    if (S.molhado) {
      const s = this._ruido(t0, 0.11, 0.7);
      const lp = this._filtro('lowpass', 900, 1.2);
      const g = this._ganho(0);
      this._env(g.gain, t0, 0.5, 0.003, 0.1);
      s.connect(lp).connect(g).connect(ent);
    }
  }

  /**
   * Passo. Varia timbre, tom e ganho a cada chamada.
   *
   * HISTORICO: aqui existia um estrangulamento GLOBAL por tempo — um passo a
   * cada 0.055 s, depois 0.03 s. Foi removido, e a remocao e o ponto principal:
   *
   *  a) o teto foi calibrado quando um passo custava ~18 nos de WebAudio. Com o
   *     cache de forma de onda custa 1, entao a razao de existir sumiu; e
   *  b) mais grave, ele derrubava por ORDEM DE CHEGADA. A IA anda todos os
   *     hostis no mesmo quadro, entao os passos de uma esquadra inteira chegam
   *     com microssegundos de diferenca e o relogio de audio nem se move entre
   *     eles: um teto por tempo guardava o PRIMEIRO da rajada e matava o resto,
   *     independentemente de o primeiro estar a 40 m e os outros a 5 m.
   *
   * Quem limita passo agora e o pool de vozes com prioridade, que e um limitador
   * melhor em todos os sentidos: passo (PRIO.passo) nunca derruba tiro nem
   * impacto, e entre passos ganha o mais perto. Sob avalanche o resultado e
   * "ouve-se quem esta chegando", e nao "ouve-se quem chegou primeiro no laco".
   */
  passo(superficie, pos, correndo = false) {
    if (!this.ativo) return;
    const chaveSup = PASSOS[superficie] ? superficie : 'concreto';
    const S = PASSOS[chaveSup];
    const t0 = this.actx.currentTime + 0.001;
    const forca = (correndo ? 1.25 : 0.85) * (0.82 + Math.random() * 0.36);

    const ent = this._voz(pos, { cauda: 0.07, beco: 0.05, ganho: S.g * forca * 0.5, vida: 0.6, prio: PRIO.passo, alcance: 48 });
    if (!ent) return;

    if (this._tocaCache(`passo:${chaveSup}:${correndo ? 'c' : 'a'}`, ent, t0, 0.45, 1, function (alvo, td) {
      this._camadasPasso(alvo, td, S, correndo);
    })) return;

    this._camadasPasso(ent, t0, S, correndo);
  }

  /** Camadas do passo. Roda ao vivo ou offline (ver `_camadasTiro`). */
  _camadasPasso(ent, t0, S, correndo) {
    const v = Math.pow(2, (Math.random() - 0.5) * 0.5);

    {
      const s = this._ruido(t0, S.dec + 0.05, 0.85 + Math.random() * 0.3);
      const bp = this._filtro('bandpass', S.f * v, S.q);
      const hp = this._filtro('highpass', S.hp, 0.5);
      const g = this._ganho(0);
      this._env(g.gain, t0, 1.0, 0.003, S.dec);
      s.connect(bp).connect(hp).connect(g).connect(ent);
    }
    // "click" do solado
    if (S.clickG > 0) {
      const s = this._ruido(t0, 0.02, 1.0);
      const bp = this._filtro('bandpass', S.click * v, 5);
      const g = this._ganho(0);
      this._env(g.gain, t0, S.clickG, 0.0008, 0.014);
      s.connect(bp).connect(g).connect(ent);
    }
    if (S.ring) {
      const o = this._osc('sine', t0, S.ring * v, S.ring * v * 0.94, 0.18);
      const g = this._ganho(0);
      this._env(g.gain, t0, 0.16, 0.002, 0.17);
      o.connect(g).connect(ent);
    }
    if (S.splash) {
      const o = this._osc('sine', t0 + 0.01, 300 * v, 1100 * v, 0.16);
      const g = this._ganho(0);
      this._env(g.gain, t0 + 0.01, 0.3, 0.006, 0.15);
      o.connect(g).connect(ent);
      const s = this._ruido(t0, 0.3, 1.0);
      const bp = this._filtro('bandpass', 1800, 0.8);
      const g2 = this._ganho(0);
      this._env(g2.gain, t0, 0.32, 0.01, 0.26);
      s.connect(bp).connect(g2).connect(ent);
    }
    // roçar de tecido/perna, so quando corre
    if (correndo) {
      const td = t0 + 0.03;
      const s = this._ruido(td, 0.12, 0.6);
      const bp = this._filtro('bandpass', 2600, 0.7);
      const g = this._ganho(0);
      this._env(g.gain, td, 0.09, 0.02, 0.1);
      s.connect(bp).connect(g).connect(ent);
    }
  }

  /** Estojo caindo no chao. `forca` 0..1. */
  cartucho(pos, forca = 1) {
    if (!this.ativo) return;
    const t0 = this.actx.currentTime + 0.001;
    const ent = this._voz(pos, { cauda: 0.1, beco: 0.06, ganho: 0.30 * (0.4 + forca * 0.6), vida: 0.5, prio: PRIO.cartucho, alcance: 30 });
    if (!ent) return;

    if (this._tocaCache('cartucho', ent, t0, 0.25, 1, function (alvo, td) {
      this._camadasCartucho(alvo, td);
    })) return;

    this._camadasCartucho(ent, t0);
  }

  /** Camadas do estojo. Roda ao vivo ou offline (ver `_camadasTiro`). */
  _camadasCartucho(ent, t0) {
    // 2-3 parciais inarmonicas: e isso que soa "latao" e nao "sino"
    const base = 3600 + Math.random() * 3200;
    const parciais = [1, 1.61 + Math.random() * 0.2, 2.37 + Math.random() * 0.3];
    for (let i = 0; i < parciais.length; i++) {
      const f = base * parciais[i];
      if (f > 15000) continue;
      const dur = 0.09 - i * 0.02 + Math.random() * 0.05;
      const o = this._osc('sine', t0, f, f * 0.93, dur);
      const g = this._ganho(0);
      this._env(g.gain, t0, (1 - i * 0.28) * 0.9, 0.0006, dur);
      o.connect(g).connect(ent);
    }
    const s = this._ruido(t0, 0.03, 1.4);
    const bp = this._filtro('bandpass', 6200, 3);
    const g = this._ganho(0);
    this._env(g.gain, t0, 0.35, 0.0006, 0.022);
    s.connect(bp).connect(g).connect(ent);
  }

  /**
   * Recarga por fase: 'start' | 'magout' | 'magin' | 'end'.
   *
   * @param {THREE.Vector3|null} pos onde a recarga acontece. Sem posicao e a
   *   recarga DO JOGADOR: retorno direto de acao dele, entao toca 2D, alta e com
   *   prioridade de contrato — tem de furar a propria rajada. Com posicao e a de
   *   um hostil: vira som do mundo, com panorama e atenuacao por distancia.
   *
   * Antes a recarga de hostil (`Enemy.js`, estado RECARREGAR) usava o mesmo
   * caminho da do jogador e saia centrada na cabeca e a todo volume, estivesse o
   * sujeito a 3 m ou a 40 — som que mentia sobre onde a acao estava e que, com
   * prioridade, ainda passaria na frente de tiro perto.
   */
  recarga(fase, pos = null) {
    if (!this.ativo) return;
    const a = this.actx;
    const t0 = a.currentTime + 0.001;
    // Um pouco de cauda dá o eco de beco sem embolar os cliques.
    const ent = this._voz(pos, {
      cauda: 0.16, beco: 0.10, vida: 0.7,
      ganho: pos ? 0.85 : 1.45,
      prio: pos ? PRIO.recargaHostil : PRIO.contrato,
      alcance: pos ? 34 : 85,
    });
    if (!ent) return;

    /** clique mecanico: banda estreita curtissima + ruido de mola */
    const clique = (dt, f, q, gan, dec) => {
      const td = t0 + dt;
      const s = this._ruido(td, dec + 0.02, 1.0);
      const bp = this._filtro('bandpass', f * (0.9 + Math.random() * 0.2), q);
      const g = this._ganho(0);
      this._env(g.gain, td, gan, 0.0008, dec);
      s.connect(bp).connect(g).connect(ent);
    };
    /** batida com corpo (pente entrando, ferrolho fechando) */
    const batida = (dt, f, gan, dec) => {
      const td = t0 + dt;
      const o = this._osc('sine', td, f, f * 0.55, dec);
      const g = this._ganho(0);
      this._env(g.gain, td, gan, 0.002, dec);
      o.connect(g).connect(ent);
    };

    switch (fase) {
      case 'start':
        clique(0, 2600, 6, 0.62, 0.026);
        clique(0.045, 1800, 4, 0.42, 0.038);   // mao subindo, roçar
        break;
      case 'magout':
        clique(0, 3400, 8, 0.95, 0.022);      // trava do pente
        clique(0.02, 1500, 3, 0.72, 0.06);
        batida(0.055, 150, 0.62, 0.13);       // pente batendo/saindo
        break;
      case 'magin':
        clique(0, 2200, 5, 0.68, 0.036);
        batida(0.02, 118, 1.05, 0.17);        // encaixe firme — o "tunk" do pente
        clique(0.075, 4200, 10, 0.90, 0.024); // trava travando
        break;
      case 'end':
        clique(0, 5200, 12, 0.85, 0.019);
        batida(0.03, 210, 0.90, 0.11);        // ferrolho fechando
        clique(0.038, 3000, 7, 1.00, 0.030);
        break;
      default:
        clique(0, 3000, 6, 0.3, 0.02);
    }
  }

  /** Gatilho seco (pente vazio). */
  cliqueSeco() {
    if (!this.ativo) return;
    const t0 = this.actx.currentTime + 0.001;
    const ent = this._voz(null, { ganho: 0.5, vida: 0.3, prio: PRIO.contrato });
    if (!ent) return;
    const s = this._ruido(t0, 0.03, 1.0);
    const bp = this._filtro('bandpass', 4600, 12);
    const g = this._ganho(0);
    this._env(g.gain, t0, 0.7, 0.0006, 0.02);
    s.connect(bp).connect(g).connect(ent);
    const o = this._osc('square', t0, 900, 620, 0.02);
    const g2 = this._ganho(0);
    this._env(g2.gain, t0, 0.18, 0.0006, 0.018);
    o.connect(g2).connect(ent);
  }

  /**
   * Voz humana sintetica (formantes). `tipo`: 'dor' | 'morte' | 'alerta'.
   */
  grito(pos, tipo = 'dor') {
    if (!this.ativo) return;
    const a = this.actx;
    const t0 = a.currentTime + 0.001;
    const cfg = tipo === 'morte'
      ? { f0: 150, f1: 78, dur: 0.95, ganho: 0.75, form: [620, 1080, 2500], vib: 5, prio: PRIO.morte }
      : tipo === 'alerta'
        ? { f0: 190, f1: 210, dur: 0.42, ganho: 0.6, form: [700, 1300, 2600], vib: 4, prio: PRIO.alerta }
        : { f0: 240, f1: 165, dur: 0.5, ganho: 0.7, form: [780, 1250, 2800], vib: 7, prio: PRIO.dor };

    const ent = this._voz(pos, { cauda: 0.3, beco: 0.24, ganho: cfg.ganho, vida: cfg.dur + 0.4, prio: cfg.prio });
    if (!ent) return;

    const v = Math.pow(2, (Math.random() - 0.5) * 0.5);
    /* Grito e raro (um por baixa) e depende da posicao e do timbre sorteado na
     * hora, entao continua sintetizado ao vivo — nao vale cache. Os osciladores
     * sao criados na mao, logo precisam ser registrados a mao para a reciclagem
     * saber desconecta-los. */
    const glote = this._reg(this.actx.createOscillator());
    glote.type = 'sawtooth';
    glote.frequency.setValueAtTime(cfg.f0 * v, t0);
    glote.frequency.exponentialRampToValueAtTime(cfg.f1 * v, t0 + cfg.dur);
    glote.start(t0); glote.stop(t0 + cfg.dur + 0.05);
    this._marcaFim(t0 + cfg.dur + 0.1);

    // vibrato: sem isso soa robo
    const lfo = this._reg(this.actx.createOscillator());
    lfo.type = 'sine';
    lfo.frequency.value = cfg.vib + Math.random() * 3;
    const lfoG = this._ganho(cfg.f0 * 0.07);
    lfo.connect(lfoG).connect(glote.frequency);
    lfo.start(t0); lfo.stop(t0 + cfg.dur + 0.05);

    const envG = this._ganho(0);
    this._env(envG.gain, t0, 1.0, 0.045, cfg.dur, 1.0);
    glote.connect(envG);

    for (let i = 0; i < cfg.form.length; i++) {
      const bp = this._filtro('bandpass', cfg.form[i] * v, 5 + i * 2);
      const g = this._ganho([0.9, 0.5, 0.24][i]);
      envG.connect(bp).connect(g).connect(ent);
    }
    // sopro
    const s = this._ruido(t0, cfg.dur, 1.0);
    const hp = this._filtro('highpass', 1800, 0.6);
    const gs = this._ganho(0);
    this._env(gs.gain, t0, 0.16, 0.05, cfg.dur);
    s.connect(hp).connect(gs).connect(ent);
  }

  /** Queda do jogador. `v` = velocidade vertical no impacto (m/s). */
  aterrissagem(v, superficie) {
    if (!this.ativo) return;
    const forte = Math.min(1, Math.abs(v) / 9);
    this.passo(superficie || 'concreto', null, true);
    if (forte < 0.35) return;
    const t0 = this.actx.currentTime + 0.001;
    const ent = this._voz(null, { cauda: 0.15, beco: 0.1, ganho: 0.5 + forte * 0.5, vida: 0.5, prio: PRIO.aterrissagem });
    if (!ent) return;
    const o = this._osc('sine', t0, 90, 46, 0.18);
    const g = this._ganho(0);
    this._env(g.gain, t0, 0.9, 0.004, 0.17);
    o.connect(g).connect(ent);
    const s = this._ruido(t0, 0.14, 0.7);
    const lp = this._filtro('lowpass', 1400, 0.8);
    const g2 = this._ganho(0);
    this._env(g2.gain, t0, 0.5, 0.003, 0.13);
    s.connect(lp).connect(g2).connect(ent);
  }

  /** Jogador levou dano: impacto surdo + respiracao curta. */
  danoJogador(intensidade = 1) {
    if (!this.ativo) return;
    const t0 = this.actx.currentTime + 0.001;
    const ent = this._voz(null, { ganho: 0.7 * intensidade, vida: 0.8, prio: PRIO.danoJogador });
    if (!ent) return;
    const o = this._osc('sine', t0, 130, 55, 0.16);
    const g = this._ganho(0);
    this._env(g.gain, t0, 0.9, 0.002, 0.15);
    o.connect(g).connect(ent);
    const s = this._ruido(t0 + 0.05, 0.35, 0.6);
    const bp = this._filtro('bandpass', 620, 1.4);
    const g2 = this._ganho(0);
    this._env(g2.gain, t0 + 0.05, 0.3, 0.03, 0.3);
    s.connect(bp).connect(g2).connect(ent);
    this._duck(0.55, 0.25);
  }

  /**
   * Zumbido pos-tiro. Senoides agudas com decaimento longo; o resto da mixagem
   * abaixa junto (ducking), que e o que faz o ouvido "fechar".
   */
  zumbido(intensidade = 1) {
    if (!this.ativo) return;
    const a = this.actx;
    const t0 = a.currentTime;
    if (t0 < this._tinnitusAte - 1.2) return;   // ja tem um tocando
    const dur = 1.6 + intensidade * 2.4;
    this._tinnitusAte = t0 + dur;

    /* O zumbido nao ocupa voz: pendura direto no master, porque o efeito e "o
     * ouvido do jogador", nao um som do mundo. Como nao ha voz, tambem nao ha
     * quem recicle os nos — por isso o `_vozAtual = null` (para nao pendurar
     * este lixo na voz do ultimo tiro, que o desconectaria cedo demais) e a
     * faxina propria no `onended` do ultimo oscilador. */
    this._vozAtual = null;
    const g = this._ganho(0);
    g.connect(this.master);
    this._env(g.gain, t0, 0.055 * intensidade, 0.02, dur, 1.0);
    const oscs = [];
    for (const [f, gg] of [[4720, 1], [6350, 0.45], [3180, 0.3]]) {
      const o = this.actx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f, t0);
      o.frequency.linearRampToValueAtTime(f * 0.985, t0 + dur);
      const gi = this._ganho(gg);
      o.connect(gi).connect(g);
      o.start(t0); o.stop(t0 + dur + 0.05);
      oscs.push(o, gi);
    }
    oscs[oscs.length - 2].onended = () => {
      for (const n of oscs) { try { n.disconnect(); } catch { /* ja solto */ } }
      try { g.disconnect(); } catch { /* ja solto */ }
    };
    this._duck(0.5, dur * 0.5);
  }

  /**
   * Abaixa temporariamente tudo que e efeito (o "ouvido fechando").
   *
   * Automatiza o no `duck`, que existe so para isto. Antes mexia no busSfx.gain,
   * o mesmo parametro do slider de efeitos e da pausa: `cancelScheduledValues`
   * de um dono cortando a rampa do outro deixa o ganho do barramento saltar, e
   * salto de ganho e clique. Com um no por dono, as automacoes se multiplicam
   * em vez de se atropelarem.
   */
  _duck(quanto, seg) {
    if (!this.ativo) return;
    const t = this.actx.currentTime;
    if (t + seg < this._duckAte) return;
    this._duckAte = t + seg;
    const p = this.duck.gain;
    p.cancelScheduledValues(t);
    p.setValueAtTime(Math.max(0.0001, p.value), t);
    p.linearRampToValueAtTime(Math.max(0.0001, 1 - quanto), t + 0.03);
    p.linearRampToValueAtTime(1, t + seg);
  }

  /* -------------------------------------------------------------------- */
  /* Ambiente                                                              */
  /* -------------------------------------------------------------------- */

  _montaAmbiente() {
    const a = this.actx;
    // O ambiente nao pertence a voz nenhuma: nada aqui pode ser registrado como
    // efemero, senao a primeira reciclagem desligaria o vento.
    this._vozAtual = null;
    // vento: duas bandas de ruido em loop, com LFO lento no corte
    const src = a.createBufferSource();
    src.buffer = this.bufRuido;
    src.loop = true;
    src.playbackRate.value = 0.35;

    const lp = this._filtro('lowpass', 420, 0.6);
    // Vento estava dominando a mixagem: a banda grave sozinha vinha mais alta que
    // o passo do jogador. Ambiente e cama, nao evento — fica abaixo de tudo.
    const gLow = this._ganho(0.11);
    const bp = this._filtro('bandpass', 1500, 0.5);
    const gHi = this._ganho(0.03);

    const lfo = a.createOscillator();
    lfo.type = 'sine'; lfo.frequency.value = 0.07;
    const lfoG = this._ganho(220);
    lfo.connect(lfoG).connect(lp.frequency);

    const lfo2 = a.createOscillator();
    lfo2.type = 'sine'; lfo2.frequency.value = 0.031;
    const lfo2G = this._ganho(0.05);
    lfo2.connect(lfo2G).connect(gLow.gain);

    src.connect(lp).connect(gLow).connect(this.busAmb);
    src.connect(bp).connect(gHi).connect(this.busAmb);

    this._ambNodes = [src, lfo, lfo2];
    this._ambIniciado = false;
  }

  _ambienteLigado() {
    if (this._ambIniciado || !this._ambNodes) return;
    const t = this.actx.currentTime + 0.05;
    for (const n of this._ambNodes) { try { n.start(t); } catch { /* ja iniciado */ } }
    this._ambIniciado = true;
  }

  /** Latido distante: dois/tres ganidos com formante grave. */
  _cachorro() {
    const a = this.actx;
    const ang = Math.random() * Math.PI * 2;
    const d = 22 + Math.random() * 45;
    const cam = this.ctx.camera?.position;
    _vAud.set((cam?.x ?? 0) + Math.cos(ang) * d, (cam?.y ?? 1.7) - 1, (cam?.z ?? 0) + Math.sin(ang) * d);
    const ent = this._voz(_vAud, { cauda: 0.5, beco: 0.55, ganho: 0.30, vida: 2.0, prio: PRIO.ambiente });
    if (!ent) return;
    const n = 2 + ((Math.random() * 3) | 0);
    let t = a.currentTime + 0.05;
    for (let i = 0; i < n; i++) {
      const f0 = 300 + Math.random() * 140;
      const dur = 0.10 + Math.random() * 0.09;
      const o = this._osc('sawtooth', t, f0, f0 * 0.55, dur);
      const bp = this._filtro('bandpass', 780 + Math.random() * 350, 2.5);
      const g = this._ganho(0);
      this._env(g.gain, t, 0.9, 0.012, dur);
      o.connect(bp).connect(g).connect(ent);
      const s = this._ruido(t, dur, 1.0);
      const bp2 = this._filtro('bandpass', 1700, 1.2);
      const g2 = this._ganho(0);
      this._env(g2.gain, t, 0.2, 0.01, dur);
      s.connect(bp2).connect(g2).connect(ent);
      t += dur + 0.09 + Math.random() * 0.16;
    }
  }

  /** Passarinho: 2-5 chilros curtos em varredura. */
  _passaro() {
    const a = this.actx;
    const cam = this.ctx.camera?.position;
    const ang = Math.random() * Math.PI * 2;
    const d = 6 + Math.random() * 16;
    _vAud.set((cam?.x ?? 0) + Math.cos(ang) * d, (cam?.y ?? 1.7) + 3 + Math.random() * 5, (cam?.z ?? 0) + Math.sin(ang) * d);
    const ent = this._voz(_vAud, { cauda: 0.3, beco: 0.2, ganho: 0.10, vida: 1.2, prio: PRIO.ambiente });
    if (!ent) return;
    let t = a.currentTime + 0.05;
    const n = 2 + ((Math.random() * 4) | 0);
    for (let i = 0; i < n; i++) {
      const f0 = 2600 + Math.random() * 2200;
      const dir = Math.random() < 0.5 ? 1.5 : 0.62;
      const dur = 0.045 + Math.random() * 0.05;
      const o = this._osc('sine', t, f0, f0 * dir, dur);
      const g = this._ganho(0);
      this._env(g.gain, t, 0.8, 0.006, dur);
      o.connect(g).connect(ent);
      t += dur + 0.03 + Math.random() * 0.08;
    }
  }

  /** Murmurio de radio: ruido em banda estreita com silabas e chiado AM. */
  _radio() {
    const a = this.actx;
    const cam = this.ctx.camera?.position;
    const ang = Math.random() * Math.PI * 2;
    const d = 8 + Math.random() * 14;
    _vAud.set((cam?.x ?? 0) + Math.cos(ang) * d, (cam?.y ?? 1.7) - 0.5, (cam?.z ?? 0) + Math.sin(ang) * d);
    const ent = this._voz(_vAud, { cauda: 0.35, beco: 0.3, ganho: 0.14, vida: 3.5, prio: PRIO.ambiente });
    if (!ent) return;

    const dur = 1.6 + Math.random() * 2.0;
    const t0 = a.currentTime + 0.05;
    const s = this._ruido(t0, dur, 0.9);
    const bp = this._filtro('bandpass', 1150, 1.4);
    const hp = this._filtro('highpass', 380, 0.7);
    const gEnv = this._ganho(0);
    gEnv.gain.setValueAtTime(0.0001, t0);
    gEnv.gain.linearRampToValueAtTime(0.5, t0 + 0.08);
    // silabas: degraus de ganho, e o que da a leitura de "alguem falando"
    let t = t0 + 0.08;
    while (t < t0 + dur - 0.15) {
      const sil = 0.07 + Math.random() * 0.13;
      const nivel = 0.12 + Math.random() * 0.85;
      gEnv.gain.setTargetAtTime(nivel, t, 0.018);
      // formante acompanha a silaba
      bp.frequency.setTargetAtTime(700 + Math.random() * 1500, t, 0.03);
      t += sil;
    }
    gEnv.gain.setTargetAtTime(0.0001, t0 + dur - 0.12, 0.05);
    s.connect(bp).connect(hp).connect(gEnv).connect(ent);
    // chiado de portadora
    const s2 = this._ruido(t0, dur, 1.3);
    const hp2 = this._filtro('highpass', 4200, 0.6);
    const g2 = this._ganho(0.05);
    s2.connect(hp2).connect(g2).connect(ent);
  }

  /** Tiroteio distante: o mapa nunca esta em paz. */
  _tiroLonge() {
    const cam = this.ctx.camera?.position;
    const ang = Math.random() * Math.PI * 2;
    const d = 70 + Math.random() * 120;
    _vAud.set((cam?.x ?? 0) + Math.cos(ang) * d, (cam?.y ?? 1.7) + Math.random() * 8, (cam?.z ?? 0) + Math.sin(ang) * d);
    const n = 1 + ((Math.random() * 5) | 0);
    for (let i = 0; i < n; i++) {
      setTimeout(() => {
        if (!this.ativo) return;
        const t0 = this.actx.currentTime + 0.001;
        const ent = this._voz(_vAud, { cauda: 0.5, beco: 0.75, ganho: 0.16, vida: 1.4, prio: PRIO.ambiente });
        if (!ent) return;
        const s = this._ruido(t0, 0.3, 1.0);
        const bp = this._filtro('bandpass', 420, 0.9);
        bp.frequency.setValueAtTime(600, t0);
        bp.frequency.exponentialRampToValueAtTime(150, t0 + 0.2);
        const g = this._ganho(0);
        this._env(g.gain, t0, 1.0, 0.003, 0.22);
        s.connect(bp).connect(g).connect(ent);
      }, i * (70 + Math.random() * 90));
    }
  }

  /* -------------------------------------------------------------------- */
  /* Eventos                                                               */
  /* -------------------------------------------------------------------- */

  _assina() {
    const bus = this.ctx.bus;
    if (!bus) return;
    this._offs.push(
      bus.on('weapon:fire', (p) => {
        this.tiro(p?.weapon?.nome || p?.weapon?.name || p?.weapon, p?.origin, true);
        // rajada colada no ouvido acumula zumbido
        if (this._tiroRecente > 0.9) this.zumbido(Math.min(1, (this._tiroRecente - 0.9) * 1.5));
      }),
      bus.on('enemy:fire', (p) => this.tiro(p?.weapon || 'fuzil', p?.origin, false)),
      bus.on('weapon:hit', (p) => this.impacto(p?.surface || 'concreto', p?.point)),
      bus.on('weapon:reload', (p) => this.recarga(p?.phase)),
      bus.on('weapon:empty', () => this.cliqueSeco()),
      bus.on('weapon:boltrelease', () => this.recarga('end')),
      bus.on('weapon:switch', () => this.recarga('start')),
      bus.on('player:footstep', (p) => this.passo(p?.surface || 'concreto', p?.position, !!p?.running)),
      bus.on('player:land', (p) => this.aterrissagem(p?.velocity ?? 3, p?.surface)),
      bus.on('player:damaged', (p) => this.danoJogador(Math.min(1, (p?.damage ?? 10) / 30))),
      bus.on('enemy:damaged', (p) => { if (Math.random() < 0.55) this.grito(p?.point, 'dor'); }),
      bus.on('enemy:killed', (p) => this.grito(p?.point, 'morte')),
      bus.on('game:pause', () => { this._pausa(true); }),
      bus.on('game:resume', () => { this._pausa(false); }),
    );
  }

  _pausa(sim) {
    this._pausado = !!sim;
    if (!this.pronto || !this.master) return;
    const t = this.actx.currentTime;
    // busAmb pendura no busSfx: um alvo so cobre efeitos e ambiente.
    this.busSfx.gain.setTargetAtTime((this.ctx.settings?.sfxVolume ?? 1) * (sim ? 0.18 : 1), t, 0.08);
  }

  /* -------------------------------------------------------------------- */

  update(dt) {
    if (!this.pronto || !this.actx) return;
    this.tempo += dt;
    this._tiroRecente = Math.max(0, this._tiroRecente - dt * 0.9);

    if (this.actx.state !== 'running') return;
    this._ambienteLigado();
    /* Devolve ao pool as vozes cujo som ja acabou. Tambem roda dentro de
     * `_voz()`, para que a reciclagem ande mesmo se o laco do jogo parar. */
    this._reciclaVozes();

    // volumes (o menu pode mexer a qualquer momento)
    const s = this.ctx.settings;
    if (s) {
      const t = this.actx.currentTime;
      // O ducking mora no no `duck`: nao ha mais disputa com o slider de efeitos.
      const alvoM = s.masterVolume ?? 0.8;
      if (Math.abs(this.master.gain.value - alvoM) > 0.001) this.master.gain.setTargetAtTime(alvoM, t, 0.05);
      // A pausa entra como fator no MESMO alvo: se fosse automacao separada, o
      // laco de volume aqui desfaria o abafamento da pausa em 50 ms.
      const alvoS = (s.sfxVolume ?? 1) * (this._pausado ? 0.18 : 1);
      if (Math.abs(this.busSfx.gain.value - alvoS) > 0.001) this.busSfx.gain.setTargetAtTime(alvoS, t, 0.05);
      const alvoMu = s.musicVolume ?? 0.35;
      if (Math.abs(this.busMus.gain.value - alvoMu) > 0.001) this.busMus.gain.setTargetAtTime(alvoMu, t, 0.05);
    }

    // --- ouvinte ----------------------------------------------------------
    const cam = this.ctx.camera;
    if (cam) {
      cam.getWorldDirection(_vDir);
      _vUp.set(0, 1, 0).applyQuaternion(cam.quaternion);
      const L = this.actx.listener;
      const t = this.actx.currentTime;
      if (this._listenerParam) {
        // rampa curta: teleporte de posicao gera clique no HRTF
        L.positionX.setTargetAtTime(cam.position.x, t, 0.01);
        L.positionY.setTargetAtTime(cam.position.y, t, 0.01);
        L.positionZ.setTargetAtTime(cam.position.z, t, 0.01);
        L.forwardX.setTargetAtTime(_vDir.x, t, 0.01);
        L.forwardY.setTargetAtTime(_vDir.y, t, 0.01);
        L.forwardZ.setTargetAtTime(_vDir.z, t, 0.01);
        L.upX.setTargetAtTime(_vUp.x, t, 0.01);
        L.upY.setTargetAtTime(_vUp.y, t, 0.01);
        L.upZ.setTargetAtTime(_vUp.z, t, 0.01);
      } else if (L.setPosition) {
        L.setPosition(cam.position.x, cam.position.y, cam.position.z);
        L.setOrientation(_vDir.x, _vDir.y, _vDir.z, _vUp.x, _vUp.y, _vUp.z);
      }
    }

    // --- vida de fundo ----------------------------------------------------
    this._proxLatido -= dt;
    if (this._proxLatido <= 0) { this._cachorro(); this._proxLatido = 14 + Math.random() * 30; }
    this._proxPassaro -= dt;
    if (this._proxPassaro <= 0) { this._passaro(); this._proxPassaro = 5 + Math.random() * 16; }
    this._proxRadio -= dt;
    if (this._proxRadio <= 0) { this._radio(); this._proxRadio = 11 + Math.random() * 22; }
    this._proxTiroLonge -= dt;
    if (this._proxTiroLonge <= 0) { this._tiroLonge(); this._proxTiroLonge = 25 + Math.random() * 55; }
  }

  setQuality() { /* audio nao depende do preset grafico */ }

  estatisticas() {
    return {
      estado: this.actx ? this.actx.state : 'sem-contexto',
      vozes: this.vozes,
      cadeias: this._poolHrtf.length + this._poolEq.length + this._poolPlano.length,
      pool: `${this._poolHrtf.length}/${this.tetos.hrtf} hrtf, ${this._poolEq.length}/${this.tetos.eq} eq, ${this._poolPlano.length}/${this.tetos.plano} plano`,
      roubos: this._roubos,
      reaproveitados: this._reaproveitados,
      formasEmCache: this._bufs.size,
      sampleRate: this.actx?.sampleRate ?? 0,
      irRua: this.convRua?.buffer?.duration ?? 0,
      irBeco: this.convBeco?.buffer?.duration ?? 0,
    };
  }

  dispose() {
    for (const off of this._offs) { try { off(); } catch { /* ignora */ } }
    this._offs.length = 0;
    this._removeGesto?.();
    for (const n of this._ambNodes || []) { try { n.stop(); } catch { /* ignora */ } }
    this._ambNodes = null;
    for (const pool of this._pools) {
      for (const v of pool) {
        this._liberaVoz(v);
        // nos de um roubo que ainda estava desvanecendo quando o motor caiu
        this._varreLixo(v, 0, Infinity);
        this._varreLixo(v, 1, Infinity);
        try { v.saida.disconnect(); } catch { /* ignora */ }
      }
      pool.length = 0;
    }
    this._bufs.clear();
    try { this.actx?.close(); } catch { /* ignora */ }
    this.pronto = false;
  }
}
