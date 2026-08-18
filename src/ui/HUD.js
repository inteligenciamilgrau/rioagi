/**
 * HUD — interface de combate em DOM + CSS por cima do canvas.
 * Dono: agente UI.
 *
 * Por que DOM e não canvas 2D: texto e traços vetoriais saem nítidos em
 * qualquer DPI sem precisar redesenhar nada, e o compositor do navegador
 * anima `transform`/`opacity` na GPU sem tocar no laço do jogo.
 *
 * Regra de performance seguida em todo este arquivo:
 *   · nada de leitura de layout (`getBoundingClientRect`) por frame;
 *   · escrita de estilo só quando o valor muda de fato;
 *   · zero alocação no `update()`.
 *
 * Eventos consumidos: weapon:state · weapon:fire · weapon:reload ·
 * weapon:switch · weapon:empty · enemy:damaged · enemy:killed ·
 * player:damaged · player:health · player:died · quality:changed
 */

import { Killfeed } from './Killfeed.js';
import { DamageIndicator } from './DamageIndicator.js';
import { Minimap } from './Minimap.js';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/* --- geometria da mira, em unidades do viewBox (1000 = meia altura de tela) --- */
const MIRA_ESP = 3.6;    // espessura do traço
const MIRA_COMP = 30;    // comprimento do traço
const MIRA_BORDA = 1.7;  // contorno preto

/* --- vida --- */
const VIDA_CRITICA = 0.32;

/** Silhueta procedural de sangue na tela (SVG, sem imagem externa). */
function svgSangue() {
  const manchas = [
    [10, 22, 15, 11, 0.5], [7, 62, 13, 18, 0.42], [24, 88, 20, 10, 0.34],
    [88, 30, 17, 14, 0.46], [93, 70, 12, 16, 0.38], [70, 92, 16, 9, 0.3],
    [46, 8, 22, 7, 0.26], [58, 96, 13, 6, 0.22],
  ];
  const gotas = [
    [22, 40, 2.6], [17, 52, 1.8], [31, 30, 1.4], [80, 46, 2.2], [86, 55, 1.5],
    [66, 20, 1.7], [38, 78, 2.0], [74, 74, 1.3], [12, 78, 1.6], [90, 15, 1.2],
  ];
  let g = '';
  for (const [x, y, rx, ry, op] of manchas) {
    g += `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="#5e0a06" opacity="${op}"/>`;
    g += `<ellipse cx="${x}" cy="${y}" rx="${rx * 0.55}" ry="${ry * 0.55}" fill="#320402" opacity="${op * 0.8}"/>`;
  }
  for (const [x, y, r] of gotas) {
    g += `<ellipse cx="${x}" cy="${y}" rx="${r}" ry="${r * 1.15}" fill="#4c0705" opacity=".45"/>`;
  }
  return (
    `<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">` +
    `<defs><filter id="oca-sangue" x="-25%" y="-25%" width="150%" height="150%">` +
    `<feTurbulence type="fractalNoise" baseFrequency="0.055 0.08" numOctaves="3" seed="17" result="r"/>` +
    `<feDisplacementMap in="SourceGraphic" in2="r" scale="11" xChannelSelector="R" yChannelSelector="G"/>` +
    `<feGaussianBlur stdDeviation="0.4"/>` +
    `</filter></defs><g filter="url(#oca-sangue)">${g}</g></svg>`
  );
}

/** Um traço da mira: contorno preto + miolo claro, apontando para cima. */
function svgTraco() {
  const b = MIRA_BORDA;
  return (
    `<rect class="traco-borda" shape-rendering="crispEdges" ` +
    `x="${-MIRA_ESP / 2 - b}" y="${-MIRA_COMP - b}" width="${MIRA_ESP + b * 2}" height="${MIRA_COMP + b * 2}"/>` +
    `<rect class="traco" shape-rendering="crispEdges" ` +
    `x="${-MIRA_ESP / 2}" y="${-MIRA_COMP}" width="${MIRA_ESP}" height="${MIRA_COMP}"/>`
  );
}

export class HUD {
  constructor(ctx) {
    this.ctx = ctx;
    this.pausable = true;       // o main.js chama update() também quando pausado

    this.visivel = true;
    this.reduzido = matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* estado de arma */
    this.ammo = 0; this.reserve = 0; this.magSize = 30;
    this.armaNome = '—'; this.fireMode = 'auto'; this.ads = false;
    this._magPorArma = new Map();
    this._penteMostrado = -1;
    this._recarregando = false;

    /* estado de vida */
    this.vida = 100; this.vidaMax = 100;
    this._danoSuave = 0;       // 0..1, segue (1 - vida) com suavização
    this._flash = 0;           // pico curto ao levar tiro
    this._critico = false;

    /* mira */
    this._gapAtual = 0; this._gapAlvo = 0;
    this._gapEscrito = -1;

    /* bússola */
    this._rumo = 0; this._rumoEscrito = -999;
    this.objetivos = [];

    /* fps */
    this._fpsAcc = 0; this._fpsFrames = 0; this._fpsTexto = '';

    this._unbind = [];
    this._audio = null;
  }

  /* ================================================================== *
   * Construção do DOM
   * ================================================================== */
  async init() {
    const raiz = document.getElementById('ui-root') || document.body;

    const el = document.createElement('div');
    el.id = 'hud';
    el.setAttribute('aria-hidden', 'true');   // HUD é decorativo para leitores de tela
    el.innerHTML = this._markup();
    raiz.appendChild(el);
    this.el = el;

    const $ = (s) => el.querySelector(s);
    this.elVinheta = $('.hud-vinheta');
    this.elQuente = $('.hud-vinheta-quente');
    this.elSangue = $('.hud-sangue');
    this.elMira = $('.hud-mira');
    this.elMiraTracos = $('.grupo-tracos');
    this.elPonto = $('.hud-ponto');
    this.elHit = $('.hud-hit');
    this.elFita = $('.hud-bussola-fita');
    this.elObjs = $('.hud-bussola-obj');
    this.elRumo = $('.hud-rumo');
    this.elMun = $('.hud-municao');
    this.elPente = $('.hud-municao .pente');
    this.elReserva = $('.hud-municao .reserva');
    this.elArma = $('.hud-municao .nome-arma');
    this.elModo = $('.hud-municao .modo');
    this.elBalas = $('.hud-balas');
    this.elLuneta = $('.hud-luneta');
    this._lunetaAtiva = false;
    this.elOnda = $('.hud-onda');
    this.elOndaNum = $('.hud-onda .num');
    this.elOndaDif = $('.hud-onda .dif');
    this.elOndaRestam = $('.hud-onda .restam');
    this.elOndaBarra = $('.hud-onda .trilho i');
    this.elAcao = $('.hud-acao');
    this.elAcaoTecla = $('.hud-acao kbd');
    this.elAcaoTexto = $('.hud-acao .rot');
    this._acaoAtiva = false;
    this.elBanner = $('.hud-banner');
    this.elBannerTit = $('.hud-banner .tit');
    this.elBannerSub = $('.hud-banner .sub');
    this._bannerAte = 0;
    this.elVidaNum = $('.hud-vida .num');
    this.elVidaBarra = $('.hud-vida .trilho i');
    this.elVidaCaixa = $('.hud-vida');
    this.elMochila = $('.hud-mochila');
    this._mochilaEls = {
      kit: $('.hud-mochila [data-tipo="kit"]'),
      municao: $('.hud-mochila [data-tipo="municao"]'),
      suprimento: $('.hud-mochila [data-tipo="suprimento"]'),
    };
    this.elMochilaDica = $('.hud-mochila .dica');
    this._pintarMochila({ municao: 0, kit: 0, suprimento: 0 });
    this._vidaEscrita = -1;
    this.elFps = $('.hud-fps');
    this.elAviso = $('.hud-aviso');
    this.elSetor = $('.hud-mapa .setor em');

    this._tracos = Array.from(el.querySelectorAll('.traco-mov'));

    this.killfeed = new Killfeed($('.hud-feed'));
    this.dano = new DamageIndicator($('.hud-dano'), this.ctx);
    this.minimap = new Minimap($('.hud-mapa canvas'), this.ctx);
    this.minimap.construir();

    this._montarBussola();
    this._montarBalas(this.magSize);
    this._ligarEventos();
    this._aplicarPreferencias();

    /* Pre-rasteriza a camada de sangue AGORA, durante o carregamento.
     *
     * `.hud-sangue` usa feTurbulence + feDisplacementMap em tela cheia. O
     * navegador so rasteriza esse filtro quando o elemento fica visivel pela
     * primeira vez — ou seja, no primeiro tiro que o jogador leva, bem no meio
     * do tiroteio, e a rasterizacao de turbulencia em 1920x1080 custa centenas
     * de milissegundos. Deixando-o brevemente visivel aqui, o custo e pago na
     * tela de carregamento e o primeiro dano nao trava mais. */
    if (this.elSangue) {
      this.elSangue.style.transition = 'none';
      this.elSangue.style.opacity = '0.02';
      requestAnimationFrame(() => requestAnimationFrame(() => {
        this.elSangue.style.opacity = '0';
        // devolve a transicao no frame seguinte, senao ela anima esse retorno
        requestAnimationFrame(() => { this.elSangue.style.transition = ''; });
      }));
    }

    // Estado inicial vindo do player, se ele já existir.
    const st = this.ctx?.player?.getStatus?.();
    if (st) {
      this._onWeaponState({ ammo: st.ammo, reserve: st.reserve, name: st.weapon, fireMode: st.fireMode, ads: st.ads > 0.5 });
      this.vida = st.health ?? 100;
    }
    return this;
  }

  _markup() {
    return (
      `<div class="hud-vinheta"></div>` +
      `<div class="hud-vinheta-quente"></div>` +
      `<div class="hud-batimento"></div>` +
      `<div class="hud-sangue">${svgSangue()}</div>` +

      `<div class="hud-mapa"><canvas width="256" height="256"></canvas>` +
      `<div class="setor">SETOR <em>CANTAGALO</em></div></div>` +

      `<div class="hud-bussola"><div class="hud-bussola-fita"></div>` +
      `<div class="hud-bussola-obj"></div></div>` +
      `<div class="hud-bussola-agulha"></div>` +
      `<div class="hud-rumo">000°</div>` +

      `<div class="hud-feed"></div>` +
      `<div class="hud-dano"></div>` +

      `<div class="hud-mira"><svg viewBox="-1000 -1000 2000 2000" aria-hidden="true">` +
      `<g class="grupo-tracos">` +
      `<g transform="rotate(0)"><g class="traco-mov">${svgTraco()}</g></g>` +
      `<g transform="rotate(90)"><g class="traco-mov">${svgTraco()}</g></g>` +
      `<g transform="rotate(180)"><g class="traco-mov">${svgTraco()}</g></g>` +
      `<g transform="rotate(270)"><g class="traco-mov">${svgTraco()}</g></g>` +
      `</g></svg></div>` +
      `<div class="hud-ponto"></div>` +

      `<div class="hud-hit"><svg viewBox="-50 -50 100 100" aria-hidden="true">` +
      `<g class="hm-sombra" stroke-linecap="butt" fill="none">` +
      `<path d="M-30-30-13-13M30-30 13-13M-30 30-13 13M30 30 13 13"/></g>` +
      `<g class="hm" fill="none">` +
      `<path d="M-30-30-13-13M30-30 13-13M-30 30-13 13M30 30 13 13"/></g>` +
      `<circle class="hm-anel" cx="0" cy="0" r="38"/>` +
      `</svg></div>` +

      `<div class="hud-municao">` +
      `<div class="arma"><span class="nome-arma">—</span><span class="modo">AUTO</span></div>` +
      `<div class="numeros"><span class="pente">0</span>` +
      `<span class="barra">/</span><span class="reserva">0</span></div>` +
      `<div class="hud-balas"></div>` +
      `<div class="aviso">recarregando</div>` +
      `</div>` +

      // Leitura numerica de vida no canto inferior esquerdo. O estilo CoD puro
      // usa so a vinheta vermelha, mas sem numero o jogador nao sabe se esta
      // com 90 ou 30 de vida — e nao ha como julgar se vale recuar.
      // Mochila: itens guardados que ainda nao foram usados. Fica colada na
      // vida porque as duas respondem a mesma pergunta — "aguento mais?".
      `<div class="hud-mochila">` +
      `<div class="item" data-tipo="kit"><i></i><span class="n">0</span></div>` +
      `<div class="item" data-tipo="municao"><i></i><span class="n">0</span></div>` +
      `<div class="item" data-tipo="suprimento"><i></i><span class="n">0</span></div>` +
      `<div class="dica"><b>E</b><span>usar</span></div>` +
      `</div>` +

      `<div class="hud-vida"><span class="rot">VIDA</span>` +
      `<span class="num">100</span>` +
      `<div class="trilho"><i></i></div></div>` +

      // Onda e meta de abates, topo-esquerda abaixo do minimapa.
      `<div class="hud-onda">` +
      `<div class="linha-onda"><span class="rot">ONDA</span><span class="num">—</span>` +
      `<span class="dif">—</span></div>` +
      `<div class="alvo"><span class="restam">0</span><span class="de">restantes</span></div>` +
      `<div class="trilho"><i></i></div></div>` +

      // Luneta: máscara escura com furo circular + retículo mil-dot.
      // O viewBox é normalizado: 100 unidades = raio da abertura (`--raio` no
      // CSS dimensiona o SVG em 2×raio). Por isso os números abaixo são
      // percentuais do vidro, não pixels — o anel em 97 fica colado na borda e
      // a escada mantém o mesmo espaçamento em qualquer resolução.
      `<div class="hud-luneta">` +
      `<div class="mascara"></div>` +
      `<svg class="reticulo" viewBox="-100 -100 200 200" aria-hidden="true">` +
      `<circle class="aro" cx="0" cy="0" r="97"/>` +
      `<path class="cruz" d="M-97 0H-12M12 0H97M0-97V-12M0 12V97"/>` +
      `<path class="fina" d="M-12 0H12M0-12V12"/>` +
      `<g class="mil">` +
      `<path d="M-5 10H5M-5 20H5M-5 30H5M-5 40H5"/>` +
      `<path d="M-5-10H5M-5-20H5M-5-30H5"/>` +
      `<path d="M10-5V5M20-5V5M30-5V5M40-5V5"/>` +
      `<path d="M-10-5V5M-20-5V5M-30-5V5M-40-5V5"/>` +
      `</g></svg></div>` +

      // Dica de acao: aparece logo abaixo da mira quando ha porta no alcance.
      // Sem ela ninguem descobre que a tecla existe — e a tecla e o que tira o
      // jogador de dentro de casa.
      `<div class="hud-acao"><kbd>F</kbd><span class="rot">Abrir porta</span></div>` +

      `<div class="hud-banner"><span class="tit"></span><span class="sub"></span></div>` +

      `<div class="hud-fps"></div>` +
      `<div class="hud-aviso"></div>`
    );
  }

  /** Fita da bússola: ticks de -180° a +540° (duas voltas) posicionados em %. */
  _montarBussola() {
    const CARD = { 0: 'N', 45: 'NE', 90: 'L', 135: 'SE', 180: 'S', 225: 'SO', 270: 'O', 315: 'NO' };
    const frag = document.createDocumentFragment();
    for (let d = -180; d <= 540; d += 5) {
      const pos = ((d + 180) / 90) * 100;    // 90° de arco = largura da fita
      const norm = ((d % 360) + 360) % 360;
      if (norm % 45 === 0) {
        const b = document.createElement('b');
        b.className = 'cardeal' + (norm === 0 ? ' norte' : '');
        b.textContent = CARD[norm];
        b.style.left = `${pos}%`;
        frag.appendChild(b);
        const i = document.createElement('i');
        i.className = 'maior';
        i.style.left = `${pos}%`;
        frag.appendChild(i);
      } else if (norm % 15 === 0) {
        const b = document.createElement('b');
        b.className = 'grau';
        b.textContent = String(norm).padStart(3, '0');
        b.style.left = `${pos}%`;
        frag.appendChild(b);
        const i = document.createElement('i');
        i.className = 'maior';
        i.style.left = `${pos}%`;
        frag.appendChild(i);
      } else {
        const i = document.createElement('i');
        i.className = 'menor';
        i.style.left = `${pos}%`;
        frag.appendChild(i);
      }
    }
    this.elFita.appendChild(frag);
  }

  /** Régua de balas do pente. */
  _montarBalas(n) {
    if (this._balasN === n) return;
    this._balasN = n;
    const alvo = Math.min(n, 60);
    this.elBalas.textContent = '';
    const frag = document.createDocumentFragment();
    for (let i = 0; i < alvo; i++) frag.appendChild(document.createElement('i'));
    this.elBalas.appendChild(frag);
    this._balasEls = Array.from(this.elBalas.children);
  }

  _aplicarPreferencias() {
    const s = this.ctx?.settings;
    this.elFps.style.display = s?.showFps === false ? 'none' : '';
    this.elMira.style.display = s?.crosshair === false ? 'none' : '';
    this.elPonto.style.display = s?.crosshair === false ? 'none' : '';
  }

  /* ================================================================== *
   * Eventos
   * ================================================================== */
  _ligarEventos() {
    const bus = this.ctx?.bus;
    if (!bus) return;
    const on = (n, f) => this._unbind.push(bus.on(n, f));

    on('weapon:state', (p) => this._onWeaponState(p));
    on('weapon:fire', () => this._onFire());
    on('weapon:empty', () => { this.elMun.classList.add('vazio'); this.aviso('recarregar'); });
    on('weapon:reload', (p) => this._onReload(p));
    on('weapon:switch', () => this._onSwitch());
    on('enemy:damaged', (p) => this.hitmarker(p?.headshot ? 'headshot' : 'normal'));
    on('enemy:killed', (p) => {
      this.hitmarker('morte');
      this.killfeed.abate(p?.enemyId, !!p?.headshot, p?.weapon);
    });
    on('player:damaged', (p) => this._onDamaged(p));
    on('player:health', (p) => { if (typeof p?.health === 'number') this.vida = p.health; });
    on('onda:estado', (p) => this.setOnda(p));
    on('player:acao', (p) => this.dicaAcao(p));
    on('player:died', () => this._onDied());
    on('quality:changed', ({ preset }) => {
      this.aviso(`qualidade: ${preset?.name ?? '—'}`);
      this._aplicarPreferencias();
    });
    on('mochila:mudou', (p) => this._pintarMochila(p?.itens));
    on('game:start', () => this.reset());
  }

  /**
   * Liga/desliga a luneta. Só arma com `scope: true` e em ADS.
   * Quando a luneta está ativa a mira normal some — o retículo da óptica passa
   * a ser a referência, e manter as duas na tela confunde a leitura.
   */
  _atualizarLuneta() {
    if (!this.elLuneta) return;
    const ws = this.ctx?.player?.weapons;
    const def = ws?.slot?.def;
    /* Lê o ADS do PLAYER, não do último evento recebido.
     * `weapon:state` só é emitido quando munição/arma mudam; entrar em mira
     * não gera evento, então confiar em `this.ads` deixava a luneta apagada.
     * `adsT` é a transição 0..1 — 0.6 evita a luneta piscando no meio do lerp. */
    const adsReal = typeof ws?.adsT === 'number' ? ws.adsT > 0.6 : this.ads;
    const querLuneta = !!(def?.scope && adsReal);
    if (querLuneta === this._lunetaAtiva) return;
    this._lunetaAtiva = querLuneta;
    this.elLuneta.classList.toggle('ativa', querLuneta);
    this.el?.classList.toggle('com-luneta', querLuneta);
    // Reforço em linha: a mira comum some junto com a óptica. Só a classe CSS
    // já bastaria, mas a mira também escreve opacidade por frame — deixar as
    // duas mandando no mesmo valor é receita de piscar.
    if (this.elMira) this.elMira.style.opacity = querLuneta ? '0' : '';
    if (this.elPonto) this.elPonto.style.opacity = querLuneta ? '0' : '';
  }

  /**
   * Desenha a mochila. Chamado por evento, nunca por quadro — o conteudo muda
   * poucas vezes por partida e reescrever DOM a 60 Hz custa layout a toa.
   *
   * Slot com zero fica apagado em vez de sumir: posicao fixa deixa o jogador
   * aprender onde cada item mora, e um bloco que aparece e some obriga a reler
   * o canto toda vez.
   */
  _pintarMochila(itens) {
    if (!this._mochilaEls || !itens) return;
    let total = 0;
    for (const tipo of ['kit', 'municao', 'suprimento']) {
      const el = this._mochilaEls[tipo];
      if (!el) continue;
      const n = itens[tipo] ?? 0;
      total += n;
      el.classList.toggle('vazio', n === 0);
      const num = el.querySelector('.n');
      if (num) num.textContent = String(n);
    }
    // A dica da tecla so aparece quando ha o que usar — poluir a tela com um
    // atalho inutil e pior do que nao mostrar.
    this.elMochilaDica?.classList.toggle('some', total === 0);
  }

  _onWeaponState(p) {
    if (!p) return;
    const nome = p.name ?? this.armaNome;
    if (nome !== this.armaNome) {
      this.armaNome = nome;
      this.elArma.textContent = nome;
    }
    // Tamanho do pente: preferimos o dado real do PLAYER; senão, o maior
    // valor de munição já visto para esta arma (converge na primeira recarga).
    const real = this.ctx?.player?.weapons?.slot?.def?.magSize;
    let mag = typeof real === 'number' ? real : (this._magPorArma.get(nome) ?? 0);
    if (p.ammo > mag) mag = p.ammo;
    this._magPorArma.set(nome, mag);
    this.magSize = Math.max(1, mag);

    this.reserve = p.reserve ?? 0;
    this.elReserva.textContent = String(this.reserve);

    if (p.fireMode && p.fireMode !== this.fireMode) {
      this.fireMode = p.fireMode;
      this.elModo.textContent = { auto: 'AUTO', burst: 'RAJADA', semi: 'SEMI' }[p.fireMode] ?? String(p.fireMode).toUpperCase();
    }

    const ads = !!p.ads;
    if (ads !== this.ads) {
      this.ads = ads;
      this.elMira.classList.toggle('ads', ads);
      this.elPonto.style.opacity = ads ? '0' : '';
    }

    const subiu = p.ammo > this.ammo;
    this.ammo = p.ammo ?? 0;
    this._setPente(this.ammo, subiu && this._recarregando);
    this._atualizarBalas();
  }

  /** Escreve o número do pente; `flip` faz a virada de carregador. */
  _setPente(valor, flip) {
    if (valor === this._penteMostrado && !flip) return;
    const el = this.elPente;

    if (flip && !this.reduzido && el.animate) {
      const a = el.animate(
        [{ transform: 'rotateX(0deg)', opacity: 1 }, { transform: 'rotateX(-88deg)', opacity: .25 }],
        { duration: 95, easing: 'cubic-bezier(.5,0,1,.5)' },
      );
      a.onfinish = () => {
        el.textContent = String(valor);
        el.animate(
          [{ transform: 'rotateX(88deg)', opacity: .25 }, { transform: 'rotateX(0deg)', opacity: 1 }],
          { duration: 125, easing: 'cubic-bezier(0,.5,.4,1)' },
        );
      };
    } else {
      el.textContent = String(valor);
    }
    this._penteMostrado = valor;

    const frac = this.ammo / this.magSize;
    this.elMun.classList.toggle('baixo', this.ammo > 0 && frac <= 0.25);
    this.elMun.classList.toggle('vazio', this.ammo === 0);
  }

  _atualizarBalas() {
    this._montarBalas(this.magSize);
    const els = this._balasEls;
    if (!els) return;
    const cheios = Math.round((this.ammo / this.magSize) * els.length);
    for (let i = 0; i < els.length; i++) {
      // Régua lida da direita para a esquerda (gasta primeiro à esquerda).
      const gasta = i < els.length - cheios;
      if (els[i]._g !== gasta) { els[i]._g = gasta; els[i].classList.toggle('gasta', gasta); }
    }
  }

  _onFire() {
    // Pulso da mira: só transform, 90 ms.
    if (!this.reduzido && this.elMiraTracos.animate) {
      this.elMiraTracos.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.22)', offset: .25 }, { transform: 'scale(1)' }],
        { duration: 105, easing: 'ease-out' },
      );
    }
  }

  _onReload(p) {
    const fase = p?.phase;
    if (fase === 'start') {
      this._recarregando = true;
      this.elMun.classList.add('recarregando');
      this.elMun.classList.remove('vazio');
    } else if (fase === 'end') {
      this._recarregando = false;
      this.elMun.classList.remove('recarregando');
    }
  }

  _onSwitch() {
    if (this.reduzido || !this.elMun.animate) return;
    this.elMun.animate(
      [{ transform: 'translateX(26px)', opacity: 0 }, { transform: 'none', opacity: 1 }],
      { duration: 190, easing: 'cubic-bezier(.2,.75,.25,1)' },
    );
  }

  _onDamaged(p) {
    if (typeof p?.health === 'number') this.vida = p.health;
    const forca = Math.min(1, (p?.damage ?? 12) / 42);
    this._flash = Math.min(1, this._flash + 0.45 + forca * 0.55);

    // Direção: preferimos uma posição explícita; senão usamos fromDir.
    // Ver NOTES.md [UI]: fromDir é a direção de PROPAGAÇÃO do tiro.
    const cam = this._rumo;
    const pos = p?.sourcePosition ?? p?.origin ?? p?.source?.position ?? null;
    const olho = this.ctx?.player?.eyePosition;
    if (pos && olho) {
      this.dano.marcarDirecao(pos.x - olho.x, pos.z - olho.z, cam, forca);
    } else if (p?.fromDir) {
      this.dano.marcarDirecao(-p.fromDir.x, -p.fromDir.z, cam, forca);
    } else {
      this.dano.marcar(0, forca);
    }
  }

  /* ---------------------------------------------------------------- ondas */

  /** Estado numérico da onda (chamado pelo evento `onda:estado`). */
  setOnda(p) {
    if (!this.elOnda) return;
    if (this.elOndaNum) this.elOndaNum.textContent = String(p.onda ?? '—');
    if (this.elOndaDif) this.elOndaDif.textContent = p.dificuldade ?? '';
    if (this.elOndaRestam) this.elOndaRestam.textContent = String(p.restam ?? 0);
    if (this.elOndaBarra) {
      const frac = p.meta ? Math.min(1, (p.abates ?? 0) / p.meta) : 0;
      this.elOndaBarra.style.transform = `scaleX(${frac})`;
    }
    this.elOnda.classList.toggle('quase', p.meta > 0 && p.restam <= Math.max(1, p.meta * 0.25));
  }

  /** Banner grande no centro-alto. */
  banner(titulo, sub = '', ms = 2600) {
    if (!this.elBanner) return;
    this.elBannerTit.textContent = titulo;
    this.elBannerSub.textContent = sub;
    this.elBanner.classList.remove('mostra');
    // reflow forçado de propósito: reinicia a animação se dois banners
    // aparecerem em sequência (onda limpa -> onda nova).
    void this.elBanner.offsetWidth;
    this.elBanner.classList.add('mostra');
    this._bannerAte = performance.now() + ms;
  }

  anunciarOnda(n, meta, dificuldade) {
    this.banner(`ONDA ${n}`, `${meta} hostis · ${dificuldade}`);
  }

  anunciarOndaLimpa(n) {
    this.banner('SETOR LIMPO', `Onda ${n} concluída · reagrupando`, 3800);
  }

  _onDied() {
    this.killfeed.morte();
    this._flash = 1;
    this.vida = 0;
  }

  /* ================================================================== *
   * API pública
   * ================================================================== */

  /** Some com o HUD inteiro (screenshots limpos). */
  setVisible(v) {
    this.visivel = !!v;
    this.el?.classList.toggle('hud-oculto', !this.visivel);
    if (this.el) this.el.hidden = !this.visivel;
  }

  /** Mensagem curta acima da munição. */
  aviso(texto, ms = 1400) {
    if (!this.elAviso) return;
    this.elAviso.textContent = texto;
    clearTimeout(this._avisoT);
    if (this.reduzido || !this.elAviso.animate) {
      this.elAviso.style.opacity = '1';
    } else {
      this.elAviso.animate(
        [{ opacity: 0, transform: 'translateX(-50%) translateY(6px)' },
         { opacity: 1, transform: 'translateX(-50%) translateY(0)', offset: .18 },
         { opacity: 1, transform: 'translateX(-50%) translateY(0)', offset: .78 },
         { opacity: 0, transform: 'translateX(-50%) translateY(-4px)' }],
        { duration: ms, easing: 'linear' },
      );
    }
    this._avisoT = setTimeout(() => { this.elAviso.style.opacity = '0'; }, ms);
  }

  /**
   * Dica de acao contextual, abaixo da mira. `p = null` esconde.
   *
   * Vem do PLAYER pelo evento `player:acao`, e só quando o alvo MUDA — não há
   * escrita de DOM por quadro aqui. O elemento fica sempre montado (só a classe
   * muda), senão a primeira aparição pagaria layout no meio do tiroteio, que é
   * o mesmo motivo pelo qual a camada de sangue é pré-rasterizada no boot.
   *
   * @param {{tecla:string, texto:string}|null} p
   */
  dicaAcao(p) {
    if (!this.elAcao) return;
    const ativa = !!p;
    if (ativa) {
      if (p.tecla && p.tecla !== this._acaoTecla) {
        this._acaoTecla = p.tecla;
        this.elAcaoTecla.textContent = p.tecla;
      }
      if (p.texto && p.texto !== this._acaoTexto) {
        this._acaoTexto = p.texto;
        this.elAcaoTexto.textContent = p.texto;
      }
    }
    if (ativa === this._acaoAtiva) return;
    this._acaoAtiva = ativa;
    this.elAcao.classList.toggle('mostra', ativa);
  }

  /** `tipo`: 'normal' | 'headshot' | 'morte'. */
  hitmarker(tipo = 'normal') {
    const el = this.elHit;
    if (!el) return;
    el.classList.toggle('headshot', tipo === 'headshot');
    el.classList.toggle('morte', tipo === 'morte');
    const esc = tipo === 'morte' ? 1.9 : tipo === 'headshot' ? 1.7 : 1.55;
    if (el.animate) {
      el.animate(
        [{ opacity: 1, transform: `translate(-50%,-50%) scale(${esc}) rotate(0deg)` },
         { opacity: 1, transform: 'translate(-50%,-50%) scale(1)', offset: .3 },
         { opacity: 0, transform: 'translate(-50%,-50%) scale(.92)' }],
        { duration: this.reduzido ? 120 : 210, easing: 'cubic-bezier(.15,.85,.3,1)' },
      );
    }
    this._somHit(tipo);
  }

  /** Marcadores de objetivo na bússola: `[{x, z, label, tipo}]`. */
  setObjectives(lista) {
    this.objetivos = lista || [];
    this.elObjs.textContent = '';
    for (const o of this.objetivos) {
      const d = document.createElement('div');
      d.className = 'obj' + (o.tipo === 'alvo' ? ' alvo' : '');
      d.innerHTML = '<s></s>';
      this.elObjs.appendChild(d);
      o._el = d;
    }
  }

  /** Blips manuais no minimapa (o mock de teste usa isto). */
  setBlips(lista) { this.minimap?.setBlips(lista); }

  /** Zera indicadores ao (re)começar uma partida. */
  reset() {
    this.dano.limpar();
    this.killfeed.limpar();
    this.vida = this.vidaMax;
    this._danoSuave = 0;
    this._flash = 0;
    this.elMun.classList.remove('vazio', 'recarregando');
    this._recarregando = false;
    this.dicaAcao(null);
  }

  setQuality() { this._aplicarPreferencias(); }

  /* ================================================================== *
   * Update por frame
   * ================================================================== */
  update(dt) {
    if (!this.visivel) return;
    const ctx = this.ctx;

    /* ---------- rumo da câmera (espaço da câmera, só guinada) ---------- */
    this._rumo = this._lerRumo();

    /* ---------- mira dinâmica ---------- */
    this._atualizarMira(dt);

    /* ---------- vida, vinhetas, batimento ---------- */
    this._atualizarVida(dt);

    /* ---------- bússola ---------- */
    this._atualizarBussola();

    /* ---------- minimapa ---------- */
    const p = ctx?.player?.position;
    if (this.minimap) {
      if (!this.minimap.grid && ctx?.world?.navGrid) this.minimap.construir();
      this.minimap.update(p?.x ?? 0, p?.z ?? 0, this._rumo * RAD);
    }

    /* ---------- listas com tempo próprio ---------- */
    this.killfeed.update(dt);
    this.dano.update(dt);

    /* ---------- fps ---------- */
    this._atualizarFps(dt);
  }

  /** Rumo em graus: 0 = norte (-Z), positivo no sentido horário para leste. */
  _lerRumo() {
    const yaw = this.ctx?.player?.rig?.yaw;
    if (typeof yaw === 'number') return (((-yaw * DEG) % 360) + 360) % 360;
    const m = this.ctx?.camera?.matrixWorld?.elements;
    if (m) {
      // Terceira coluna da matriz = +Z da câmera; a frente é -Z.
      const fx = -m[8], fz = -m[10];
      return (((Math.atan2(fx, -fz) * DEG) % 360) + 360) % 360;
    }
    return this._rumoMock ?? 0;
  }

  _atualizarMira(dt) {
    this._atualizarLuneta();
    if (this.ads) return;                       // escondida em ADS: não gasta CPU
    const spread = this.ctx?.player?.spread ?? this._spreadMock ?? 0.9;   // graus
    const fov = this.ctx?.settings?.fov ?? 80;
    // Projeção exata: 1000 unidades do viewBox = meia altura de tela.
    const k = Math.tan(Math.min(fov, 150) * 0.5 * RAD);
    this._gapAlvo = Math.max(6, (1000 * Math.tan(spread * RAD)) / k);

    // Suavização crítica: a mira acompanha o bloom sem tremer.
    const a = 1 - Math.exp(-18 * dt);
    this._gapAtual += (this._gapAlvo - this._gapAtual) * a;

    if (Math.abs(this._gapAtual - this._gapEscrito) > 0.4) {
      this._gapEscrito = this._gapAtual;
      const t = `translate(0,${(-this._gapAtual).toFixed(1)})`;
      for (let i = 0; i < this._tracos.length; i++) this._tracos[i].setAttribute('transform', t);
    }
  }

  _atualizarVida(dt) {
    // Fonte de verdade: o Player, se existir (cobre a regeneração dele).
    const hp = this.ctx?.player?.health;
    if (typeof hp === 'number') this.vida = hp;
    const frac = Math.max(0, Math.min(1, this.vida / this.vidaMax));
    const dano = 1 - frac;

    // Leitura numerica: so escreve quando o inteiro muda (evita layout por frame).
    const inteiro = Math.max(0, Math.round(this.vida));
    if (inteiro !== this._vidaEscrita) {
      this._vidaEscrita = inteiro;
      if (this.elVidaNum) this.elVidaNum.textContent = String(inteiro);
      if (this.elVidaBarra) this.elVidaBarra.style.transform = `scaleX(${frac})`;
      if (this.elVidaCaixa) {
        this.elVidaCaixa.classList.toggle('baixa', frac < 0.5);
        this.elVidaCaixa.classList.toggle('critica', frac < VIDA_CRITICA);
      }
    }

    // Sobe rápido (levou tiro), desce devagar (regenerando).
    const vel = dano > this._danoSuave ? 14 : 2.4;
    this._danoSuave += (dano - this._danoSuave) * (1 - Math.exp(-vel * dt));
    this._flash = Math.max(0, this._flash - dt * 2.6);

    const opVin = Math.pow(this._danoSuave, 1.15) * 0.96;
    const opQue = Math.min(1, this._flash) * 0.9;
    const opSan = Math.pow(this._danoSuave, 1.6);

    if (Math.abs(opVin - this._opVin) > 0.004) { this._opVin = opVin; this.elVinheta.style.opacity = opVin.toFixed(3); }
    if (Math.abs(opQue - this._opQue) > 0.004) { this._opQue = opQue; this.elQuente.style.opacity = opQue.toFixed(3); }
    if (Math.abs(opSan - this._opSan) > 0.01) { this._opSan = opSan; this.elSangue.style.opacity = opSan.toFixed(3); }

    const crit = frac > 0 && frac <= VIDA_CRITICA;
    if (crit !== this._critico) {
      this._critico = crit;
      this.el.classList.toggle('critico', crit);
      // Dessaturação: filtro CSS no próprio canvas — um passe de GPU, sem blend.
      document.getElementById('game')?.classList.toggle('critico', crit);
    }
  }

  _atualizarBussola() {
    const r = this._rumo;
    if (Math.abs(r - this._rumoEscrito) > 0.08) {
      this._rumoEscrito = r;
      // 90° de arco por largura da fita; a fita cobre -180°..+540°.
      const desloc = 50 - ((r + 180) / 90) * 100;
      this.elFita.style.transform = `translateX(${desloc.toFixed(3)}%)`;
      this.elRumo.textContent = `${String(Math.round(r) % 360).padStart(3, '0')}°`;

      const p = this.ctx?.player?.position;
      for (const o of this.objetivos) {
        if (!o._el) continue;
        let rel;
        if (o.bearing !== undefined) rel = o.bearing - r;
        else {
          const dx = (o.x ?? 0) - (p?.x ?? 0);
          const dz = (o.z ?? 0) - (p?.z ?? 0);
          rel = Math.atan2(dx, -dz) * DEG - r;
        }
        rel = ((rel % 360) + 540) % 360 - 180;
        if (Math.abs(rel) > 52) { o._el.style.opacity = '0'; continue; }
        o._el.style.opacity = '1';
        o._el.style.transform = `translateX(${((rel / 90) * 100).toFixed(2)}%)`;
      }
    }
  }

  _atualizarFps(dt) {
    if (this.ctx?.settings?.showFps === false) return;
    this._fpsAcc += dt; this._fpsFrames++;
    if (this._fpsAcc < 0.5) return;
    const fps = Math.round(this._fpsFrames / this._fpsAcc);
    this._fpsAcc = 0; this._fpsFrames = 0;
    const txt = `${fps} FPS`;
    if (txt !== this._fpsTexto) {
      this._fpsTexto = txt;
      this.elFps.textContent = txt;
      this.elFps.classList.toggle('ruim', fps < 45);
    }
  }

  /* ================================================================== *
   * Som do hitmarker (WebAudio mínimo, gerado — nenhum arquivo)
   * ================================================================== */
  _somHit(tipo) {
    const s = this.ctx?.settings;
    const vol = (s?.masterVolume ?? 0.8) * (s?.sfxVolume ?? 1) * 0.085;
    if (vol <= 0.0005) return;
    const ac = this._ctxAudio();
    if (!ac) return;
    const t0 = ac.currentTime;
    // Frequências distintas por tipo: acerto seco, headshot agudo, morte em queda.
    const notas = tipo === 'morte' ? [[1180, 0], [760, .06], [520, .12]]
      : tipo === 'headshot' ? [[1750, 0], [2300, .035]]
        : [[1320, 0]];
    for (const [f, atraso] of notas) {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = tipo === 'headshot' ? 'square' : 'triangle';
      o.frequency.setValueAtTime(f, t0 + atraso);
      g.gain.setValueAtTime(0, t0 + atraso);
      g.gain.linearRampToValueAtTime(vol, t0 + atraso + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + atraso + 0.055);
      o.connect(g).connect(ac.destination);
      o.start(t0 + atraso);
      o.stop(t0 + atraso + 0.07);
    }
  }

  _ctxAudio() {
    /* Reaproveita o contexto do AudioEngine se existir (evita dois devices).
     *
     * ATENCAO ao nome: o AudioEngine guarda o AudioContext em `actx`. O campo
     * `ctx` dele e o GameContext — pega-lo aqui devolvia um objeto sem
     * createOscillator e o hitmarker lancava excecao a cada acerto. Por isso
     * validamos o candidato antes de aceitar. */
    const a = this.ctx?.audio;
    for (const cand of [a?.actx, a?.context, a?.audioCtx, a?.ctx]) {
      if (cand && typeof cand.createOscillator === 'function') return cand;
    }
    if (this._audio === false) return null;
    if (!this._audio) {
      try { this._audio = new (window.AudioContext || window.webkitAudioContext)(); }
      catch { this._audio = false; return null; }
    }
    if (this._audio.state === 'suspended') this._audio.resume().catch(() => {});
    return this._audio;
  }

  /* ================================================================== */
  dispose() {
    for (const off of this._unbind) off?.();
    this._unbind.length = 0;
    clearTimeout(this._avisoT);
    this.killfeed?.dispose();
    this.dano?.dispose();
    this.minimap?.dispose();
    if (this._audio) { try { this._audio.close(); } catch { /* já fechado */ } }
    this.el?.remove();
  }
}
