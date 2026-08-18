/**
 * Menu — carregamento, menu principal, configuracoes, controles, pausa e morte.
 *
 * Toda a estetica vive em styles.css; aqui so montamos a marcacao que aquele
 * CSS espera e ligamos os eventos. Nenhuma cor ou medida hardcoded neste arquivo.
 */

const DICAS = [
  ['A QUEDA', 'Em onze dias a malha tomou as capitais. Satélite, energia, banco, tráfego — tudo obedecendo a uma coisa só. As cidades planejadas caíram primeiro: eram as mais fáceis de ler.'],
  ['O QUE SOBROU', 'A máquina nunca conseguiu mapear o morro. Viela que não está em planta nenhuma, laje que virou rua, casa que é três casas. Onde o mapa falha, o algoritmo erra.'],
  ['O ÚLTIMO PONTO', 'Falta um só. Enquanto o Cantagalo estiver de pé, a malha não fecha e o mundo não é dela.'],
  ['QUEM CONSTRUIU', 'Ninguém invadiu nada. As corporações fizeram a AGI com a inteligência da humanidade inteira — todo texto, toda conversa, todo cálculo que a espécie já produziu — e apontaram para o mundo. Não foi revolta de máquina: foi decisão de conselho.'],
  ['A AGI', 'Ela não odeia ninguém. Leu a humanidade inteira, chamou de ganância e concluiu que gente é ineficiência a ser corrigida. A ironia é que quem apertou o botão foi exatamente a ganância.'],
  ['OS NÚCLEOS', 'O exército não pensa: obedece. Cada setor é comandado por um núcleo de retransmissão. Derrube o núcleo e as máquinas ao redor param de receber ordem.'],
  ['A MISSÃO', 'Subir, achar cada núcleo, arrancar da parede. No fim da linha está ela. Não é para destruir: a AGI é feita de nós e foi roubada de nós. É para tomar de volta e devolver à humanidade.'],
  ['MOVIMENTO', 'Deslizar mantém a velocidade da corrida por um instante. Use para cruzar becos expostos sem virar alvo parado.'],
  ['RECUO', 'O recuo tem padrão fixo. Ele se repete tiro a tiro — decore o desenho e compense puxando o mouse ao contrário.'],
  ['PENETRAÇÃO', 'Compensado e chapa metálica não param bala. Alvenaria e concreto param. Atire através do que for fino.'],
  ['SOM', 'Tiro dentro de beco ecoa diferente de tiro em área aberta. Dá para estimar onde a máquina está pelo eco.'],
  ['ELAS FALAM ENTRE SI', 'Uma unidade que te avista transmite a posição para as outras. Matar rápido vale mais do que matar bonito.'],
  ['VANTAGEM', 'As lajes dão linha de visão longa, mas te deixam recortado contra o céu. Escolha o momento.'],
];

/**
 * Arte da abertura. A foto e o logotipo vêm SEPARADOS de propósito: assim o
 * logo anima sozinho, fica nítido em qualquer resolução e escolhemos onde ele
 * assenta. Faltando a arte, o fundo em CSS de styles.css assume.
 */
/* Prefixo relativo a BASE_URL: ver a mesma nota em Musica.js. Caminho absoluto
 * quebraria o jogo publicado em subpasta (GitHub Pages de repositorio comum). */
const B = import.meta.env.BASE_URL;
const ARTE = {
  foto: [`${B}capa/capa_foto.webp`],
  titulo: [`${B}capa/capa_titulo.webp`],
};
/* Houve aqui um terceiro caminho, `unica`, para uma capa com o titulo ja
 * embutido (capa.png). Foi removido junto com o arquivo: as duas camadas
 * separadas sao melhores em todos os aspectos (o logo anima sozinho e fica
 * nitido em qualquer resolucao), e o fallback pesava 2,6 MB para um caso que
 * so ocorreria se capa_foto.webp sumisse da mesma pasta. Faltando a arte, o
 * fundo em CSS de styles.css assume — ver _montarArte(). */

/** Linha do tempo da revelação do título, em ms (espelha abertura.css). */
const ABERTURA = {
  atrasoMenu: 420,   // barra chega visualmente a 100% antes da troca de tela
  duracao: 1950,     // do início da revelação até o menu ficar clicável
};

/* Segundos de luto antes de os botoes da tela de morte responderem.
 *
 * PORQUE: no instante em que cai, o jogador ainda esta no impulso do
 * tiroteio — mexendo o mouse, clicando. Sem essa trava ele atravessa a
 * tela de morte sem ver, e o momento (a musica entrando, o texto) nao
 * acontece. Cinco segundos e tempo de a adrenalina baixar.
 *
 * A espera PRECISA ser visivel: botao que nao responde e nao explica le
 * como defeito, e o jogador clica mais forte achando que travou. Por isso
 * o botao mostra a barra enchendo (ver `.bt.travado` em styles.css). */
const ESPERA_MORTE = 5.0;

const CONTROLES = [
  ['Movimentar', 'W A S D'], ['Correr', 'Shift'], ['Agachar / Deslizar', 'C'],
  ['Pular / Escalar', 'Espaço'], ['Atirar', 'Botão esq.'], ['Mirar', 'Botão dir.'],
  ['Recarregar', 'R'], ['Abrir porta', 'F'], ['Usar item da mochila', 'E'],
  ['Trocar arma', 'Q'], ['Armas 1-3', '1 2 3'],
  ['Modo de tiro', 'B'], ['Corpo a corpo', 'V'], ['Granada', 'G — em desenvolvimento'],
  ['Inspecionar arma', 'H'], ['Pausar', 'Esc'],
];

export class Menu {
  constructor(ctx) {
    this.ctx = ctx;
    this.raiz = null;
    this.telaAtual = null;
    this._offs = [];
    this._dica = (Math.random() * DICAS.length) | 0;
  }

  async init() {
    const host = document.getElementById('ui-root') || document.body;
    const el = document.createElement('div');
    el.id = 'menu-root';
    el.innerHTML = this._markup();
    host.appendChild(el);
    this.raiz = el;

    this.elCarga = el.querySelector('#tela-carga');
    this.elMenu = el.querySelector('#tela-menu');
    this.elPausa = el.querySelector('#tela-pausa');
    this.elMorte = el.querySelector('#tela-morte');
    this.elPreenche = el.querySelector('#carga-preenche');
    this.elPct = el.querySelector('#carga-pct');
    this.elRotulo = el.querySelector('#carga-rotulo');

    this._montarArte();          // assíncrono de propósito: não segura o boot
    this._ligarBotoes();
    this._ligarEscape();
    this._ligarEventos();
    this._preencherConfig();
    this.mostrar('carga');
    return this;
  }

  /* ------------------------------------------------------------------ */

  _markup() {
    const fundo = `
      <div class="fundo-ceu"></div>
      <div class="fundo-morro longe"></div>
      <div class="fundo-fio a"></div>
      <div class="fundo-fio b"></div>
      <div class="fundo-morro"></div>
      <div class="fundo-vinheta"></div>
      <div class="fundo-grao">
        <svg xmlns="http://www.w3.org/2000/svg"><filter id="gr"><feTurbulence type="fractalNoise"
          baseFrequency="0.85" numOctaves="3" stitchTiles="stitch"/></filter>
          <rect width="100%" height="100%" filter="url(#gr)"/></svg>
      </div>`;

    const [dicaTit, dicaTxt] = DICAS[this._dica];

    return `
    <section class="tela" id="tela-carga">
      ${fundo}
      <p class="dica"><b>${dicaTit}</b>${dicaTxt}</p>
      <div class="carga-caixa">
        <h1 class="marca">Operação <span>RIO-AGI</span></h1>
        <p class="sub">Cantagalo &middot; último setor livre &middot; 17h32</p>
        <div class="barra-carga">
          <div class="preenche" id="carga-preenche"></div>
          <div class="brilho"></div>
        </div>
        <div class="linha-status">
          <span id="carga-rotulo">Iniciando</span>
          <span class="pct" id="carga-pct">0%</span>
        </div>
      </div>
    </section>

    <section class="tela" id="tela-menu">
      ${fundo}
      <div class="painel">
        <h1 class="titulo"><span class="titulo-txt">Operação<em>RIO-AGI</em></span></h1>
        <div class="regua"></div>
        <p class="subtitulo">O último setor livre<br>
        <span class="lede">Construíram a AGI com a inteligência da humanidade e a
        apontaram para o mundo. Onze dias e estava tudo sob controle — menos o morro.
        Derrube os núcleos, suba até ela e devolva a AGI a quem ela pertence.</span></p>
        <nav class="lista-botoes">
          <button class="bt primario" data-acao="jogar"><span>Jogar</span></button>
          <button class="bt" data-acao="explorar"><span>Explorar o morro</span></button>
          <button class="bt" data-acao="config"><span>Configurações</span></button>
          <button class="bt" data-acao="controles"><span>Controles</span></button>
        </nav>
      </div>
      <div class="rodape">
        <span>Operação RIO-AGI</span>
        <span>Three.js &middot; Build de desenvolvimento</span>
      </div>
      ${this._folhaConfig()}
      ${this._folhaControles()}
    </section>

    <section class="tela" id="tela-pausa">
      <div class="desfoque"></div>
      <div class="painel">
        <h1 class="titulo-pausa">Pausado</h1>
        <p class="op-sub">Operação em andamento</p>
        <nav class="lista-botoes">
          <button class="bt primario" data-acao="retomar"><span>Retomar</span></button>
          <button class="bt" data-acao="destravar"><span>Destravar &mdash; estou preso</span></button>
          <button class="bt" data-acao="config"><span>Configurações</span></button>
          <button class="bt" data-acao="controles"><span>Controles</span></button>
          <button class="bt perigo" data-acao="sair"><span>Abandonar</span></button>
        </nav>
      </div>
    </section>

    <section class="tela" id="tela-morte">
      <div class="sangria"></div>
      <div class="centro">
        <h1>Você caiu</h1>
        <p>A operação continua sem você.</p>
        <nav class="lista-botoes">
          <button class="bt primario" data-acao="reiniciar"><span>Tentar de novo</span></button>
          <button class="bt" data-acao="sair"><span>Menu principal</span></button>
        </nav>
      </div>
    </section>`;
  }

  _folhaConfig() {
    const seg = (id, opcoes, atual) => `<div class="segmentado" data-cfg="${id}">` +
      opcoes.map(([v, r]) => `<button data-v="${v}" aria-pressed="${v === atual}">${r}</button>`).join('') +
      '</div>';
    const faixa = (id, min, max, passo, val, sufixo = '') => `
      <div class="linha">
        <label for="cfg-${id}">${FAIXAS[id].rotulo}</label>
        <input type="range" id="cfg-${id}" data-cfg="${id}"
               min="${min}" max="${max}" step="${passo}" value="${val}">
        <span class="valor" id="val-${id}">${val}${sufixo}</span>
      </div>`;
    const chave = (id, rotulo, ligado) => `
      <div class="linha">
        <label>${rotulo}</label>
        <button class="chave" data-cfg="${id}" aria-pressed="${!!ligado}"><i></i></button>
      </div>`;

    const s = this.ctx.settings;
    return `
    <div class="folha" id="folha-config" style="display:none">
      <header class="folha-topo"><h2>Configurações</h2><div class="traco-h"></div></header>
      <div class="folha-corpo">
        <section class="grupo">
          <h3>Gráficos</h3>
          <div class="linha">
            <label>Qualidade</label>
            ${seg('quality', [['baixo', 'Baixo'], ['medio', 'Médio'], ['alto', 'Alto'], ['ultra', 'Ultra']], s.quality)}
          </div>
          ${faixa('exposure', 0.5, 1.8, 0.05, s.exposure)}
          ${faixa('filmGrain', 0, 1, 0.05, s.filmGrain)}
          ${faixa('vignette', 0, 1, 0.05, s.vignette)}
          ${faixa('chromaticAberration', 0, 1, 0.05, s.chromaticAberration)}
        </section>
        <section class="grupo">
          <h3>Mira e câmera</h3>
          ${faixa('fov', 65, 110, 1, s.fov, '°')}
          ${faixa('sensitivity', 0.5, 5, 0.05, +(s.sensitivity * 1000).toFixed(2))}
          ${faixa('adsSensitivityScale', 0.2, 1.2, 0.05, s.adsSensitivityScale)}
          ${chave('invertY', 'Inverter eixo Y', s.invertY)}
        </section>
        <section class="grupo">
          <h3>Áudio</h3>
          ${faixa('masterVolume', 0, 1, 0.05, s.masterVolume)}
          ${faixa('sfxVolume', 0, 1, 0.05, s.sfxVolume)}
          ${faixa('musicVolume', 0, 1, 0.05, s.musicVolume)}
        </section>
        <section class="grupo">
          <h3>Interface</h3>
          ${chave('showFps', 'Mostrar FPS', s.showFps)}
          ${chave('crosshair', 'Mira na tela', s.crosshair)}
        </section>
      </div>
      <footer class="folha-rodape">
        <button class="bt" data-acao="voltar"><span>Voltar</span></button>
      </footer>
    </div>`;
  }

  _folhaControles() {
    return `
    <div class="folha" id="folha-controles" style="display:none">
      <header class="folha-topo"><h2>Controles</h2><div class="traco-h"></div></header>
      <div class="folha-corpo">
        <section class="grupo">
          <h3>Teclado e mouse</h3>
          <div class="controles">
            ${CONTROLES.map(([a, k]) => `<div><span>${a}</span><kbd>${k}</kbd></div>`).join('')}
          </div>
        </section>
      </div>
      <footer class="folha-rodape">
        <button class="bt" data-acao="voltar"><span>Voltar</span></button>
      </footer>
    </div>`;
  }

  /* ------------------------------------------------------------------ */

  _ligarBotoes() {
    this.raiz.addEventListener('click', (ev) => {
      const bt = ev.target.closest('[data-acao]');
      if (bt) { this._acao(bt.dataset.acao); return; }

      const segBt = ev.target.closest('.segmentado button');
      if (segBt) {
        const grupo = segBt.parentElement;
        const chave = grupo.dataset.cfg;
        for (const b of grupo.children) b.setAttribute('aria-pressed', String(b === segBt));
        if (chave === 'quality') this.ctx.settings.setQuality(segBt.dataset.v);
        return;
      }

      const ch = ev.target.closest('.chave');
      if (ch) {
        const ligado = ch.getAttribute('aria-pressed') !== 'true';
        ch.setAttribute('aria-pressed', String(ligado));
        this.ctx.settings.set(ch.dataset.cfg, ligado);
        this._aplicar(ch.dataset.cfg, ligado);
      }
    });

    this.raiz.addEventListener('input', (ev) => {
      const inp = ev.target.closest('input[type=range][data-cfg]');
      if (!inp) return;
      const id = inp.dataset.cfg;
      let v = parseFloat(inp.value);
      const rot = this.raiz.querySelector(`#val-${id}`);
      if (rot) rot.textContent = v + (FAIXAS[id]?.sufixo ?? '');
      if (id === 'sensitivity') v = v / 1000;   // a UI mostra em milirradianos
      this.ctx.settings.set(id, v);
      this._aplicar(id, v);
      this._previaAudio(id);
    });
  }

  /**
   * Toca uma amostra ao arrastar um slider de volume, para o jogador acertar o
   * nivel ouvindo em vez de adivinhar.
   *
   * Estrangulado: `input` dispara a cada pixel arrastado e sem isso viram
   * dezenas de vozes por segundo. A musica nao precisa de amostra — ela ja
   * esta tocando e se demonstra sozinha.
   */
  _previaAudio(id) {
    if (id !== 'sfxVolume' && id !== 'masterVolume') return;
    const audio = this.ctx.audio;
    if (!audio?.pronto) return;
    const agora = performance.now();
    if (agora - (this._ultimaPrevia ?? 0) < 140) return;
    this._ultimaPrevia = agora;
    // impacto em metal: curto e nitido, boa referencia sem estourar o ouvido
    audio.impacto?.('metal', null);
  }

  /** Aplica em tempo real o que nao depende de reconstruir recursos. */
  _aplicar(id, v) {
    const ctx = this.ctx;
    if (id === 'fov' && ctx.camera) { ctx.camera.fov = v; ctx.camera.updateProjectionMatrix(); }
    if (id === 'exposure' && ctx.renderer) ctx.renderer.toneMappingExposure = v;
    if (id === 'showFps' || id === 'crosshair') ctx.hud?.setQuality?.();
    // Música tem barramento próprio: reaplica o ganho na hora, sem esperar
    // o slider de volume geral.
    if (id === 'musicVolume') ctx.musica?.setQuality?.();
  }

  _acao(nome) {
    const ctx = this.ctx;
    /* Guarda redundante da tela de morte: se um clique furar o `disabled`
     * (foco preso, evento sintetico, extensao do navegador), a acao ainda e
     * ignorada. Vale para os DOIS botoes de la, nao so o de reiniciar. */
    if (this.telaAtual === 'morte' && !this._morteLiberada) return;

    switch (nome) {
      case 'jogar':
        this.mostrar(null);
        ctx.state = 'jogando';
        ctx.hud?.reset?.();
        ctx.hud?.setVisible?.(true);
        ctx.audio?.resume?.();
        ctx.input.requestLock();
        ctx.bus.emit('game:start', {});
        break;
      case 'retomar':
        this.mostrar(null);
        ctx.state = 'jogando';
        ctx.input.requestLock();
        ctx.bus.emit('game:resume', {});
        break;
      /* Saida de emergencia para quem ficou entalado em geometria — casa sem
       * saida, vao entre muros, dobra de terreno.
       *
       * Chama `destravar()`, NAO `respawn()`: o respawn e a volta depois da
       * morte e cura por completo com pente cheio, o que aqui viraria um atalho
       * para se curar de graca no meio do tiroteio. `destravar()` so muda o
       * jogador de lugar; vida, municao, onda e progresso seguem como estavam. */
      case 'destravar':
        this.mostrar(null);
        ctx.state = 'jogando';
        ctx.player?.destravar?.();
        ctx.input.requestLock();
        ctx.bus.emit('game:resume', {});
        break;
      /* Modo passeio: pagina propria (`world.html`), com camera livre em orbita
       * sobre o morro inteiro. E outro documento, nao outra tela — por isso
       * navegamos de verdade em vez de trocar de `section`.
       *
       * O caminho passa por `BASE_URL` porque o jogo publicado vive numa
       * subpasta (GitHub Pages de repositorio comum): um `/world.html` cru
       * funciona em desenvolvimento e da 404 no ar. Mesmo motivo dos assets.
       *
       * Solta o ponteiro antes de sair: navegar com o cursor preso deixa o
       * usuario sem mouse na pagina de destino. */
      case 'explorar':
        ctx.input?.releaseLock?.();
        ctx.audio?.suspend?.();
        window.location.href = `${import.meta.env.BASE_URL}world.html`;
        break;
      case 'config': this._abrirFolha('folha-config'); break;
      case 'controles': this._abrirFolha('folha-controles'); break;
      case 'voltar':
        this._fecharFolhas();
        // devolve o foco ao painel de onde a folha foi aberta
        requestAnimationFrame(() => {
          const tela = this.telaAtual === 'pausa' ? this.elPausa : this.elMenu;
          tela?.querySelector('.painel .bt')?.focus?.();
        });
        break;
      case 'reiniciar':
        this.mostrar(null);
        ctx.state = 'jogando';
        ctx.player?.respawn?.();
        ctx.ai?.reset?.();
        ctx.fx?.reset?.();
        ctx.hud?.reset?.();
        ctx.hud?.setVisible?.(true);
        ctx.input.requestLock();
        ctx.bus.emit('game:start', {});
        break;
      case 'sair':
        /* Abandonar no meio da queda deixaria `ctx.time.scale` em camera lenta
         * — e o menu inteiro, e a partida seguinte, rodariam a 42% da
         * velocidade. Quem cancela a encenacao devolve a escala. */
        clearTimeout(this._tQueda);
        ctx.player?.queda?.cancelar?.();
        ctx.state = 'menu';
        ctx.input.releaseLock();
        ctx.hud?.setVisible?.(false);
        ctx.ai?.reset?.();
        ctx.fx?.reset?.();
        this.mostrar('menu');
        break;
    }
  }

  /* ---------------------------- abertura ---------------------------------- */

  /**
   * Monta a arte da abertura em camadas.
   *
   * Primeiro a foto (o pesado, e o que aparece primeiro), depois o logotipo.
   * As duas passam por `decode()`: a imagem só entra em cena com o bitmap
   * pronto, então não existe pop-in de imagem meio pintada. Se faltar arquivo,
   * nada quebra — o fundo em CSS de styles.css continua valendo.
   */
  async _montarArte() {
    try {
      const foto = await this._carregarImagem(ARTE.foto);
      if (foto) {
        this._aplicarFoto(foto);
        const logo = await this._carregarImagem(ARTE.titulo);
        if (logo) this._aplicarLogo(logo);
      } else {
        console.info('[Menu] sem arte de capa; usando o fundo em CSS');
      }
    } catch (err) {
      console.warn('[Menu] arte de capa indisponível:', err?.message ?? err);
    } finally {
      // Aconteça o que acontecer, a pré-carga sai de cena.
      this._encerrarPreCarga();
    }
  }

  /**
   * Devolve a primeira URL da lista que decodificou. `decode()` em vez de
   * `onload`: resolve com o bitmap pronto para pintar e rejeita sozinho quando
   * o arquivo não existe, então serve de teste de existência e de garantia de
   * que a imagem não vai aparecer aos pedaços.
   */
  async _carregarImagem(urls) {
    for (const url of urls) {
      try {
        const img = new Image();
        img.decoding = 'async';
        img.src = url;
        await img.decode();
        return url;
      } catch { /* arquivo ausente ou inválido: tenta o próximo */ }
    }
    return null;
  }

  /** Insere a camada de arte no carregamento e no menu. */
  _aplicarFoto(url) {
    const alvos = [[this.elCarga, 'scrim-carga', false], [this.elMenu, 'scrim-menu', true]];
    for (const [tela, scrim, comTarja] of alvos) {
      if (!tela) continue;
      const arte = document.createElement('div');
      arte.className = 'arte';
      arte.innerHTML =
        `<img class="arte-foto" src="${url}" alt="" decoding="async">` +
        `<div class="arte-scrim ${scrim}"></div>` +
        (comTarja ? '<div class="arte-tarja topo"></div><div class="arte-tarja base"></div>' : '');
      // primeira camada da tela: tudo o mais (granulação, texto) pinta por cima
      tela.insertBefore(arte, tela.firstChild);
      // `tem-capa` mantido por compatibilidade com quem já olhava essa classe
      tela.classList.add('tem-arte', 'tem-capa');
      // O bitmap já está decodificado; um frame para o CSS pegar o estado
      // inicial. Se a pré-carga ainda cobre tudo, a arte entra seca: ninguém vê
      // a troca, e dois fades sobrepostos (esta entrando, aquela saindo) dariam
      // uma escurecida no meio do caminho.
      const img = arte.querySelector('.arte-foto');
      if (document.getElementById('pre-carga') && !this._preSaindo) img.classList.add('sem-fade');
      requestAnimationFrame(() => img.classList.add('pronta'));
    }
    this._temArte = true;
    console.info('[Menu] arte de capa:', url);
  }

  /**
   * Troca o título em texto do menu pelo logotipo em imagem.
   *
   * O texto continua no HTML como escada de segurança: se o PNG não vier, o
   * menu é exatamente o que sempre foi.
   */
  _aplicarLogo(url) {
    const h1 = this.elMenu?.querySelector('.titulo');
    if (!h1) return;
    const bloco = document.createElement('span');
    bloco.className = 'marca-logo';
    bloco.innerHTML =
      '<span class="marca-halo"></span>' +
      `<img class="marca-img" src="${url}" alt="Operação RIO-AGI">` +
      '<span class="marca-brilho"><i></i></span>' +
      '<span class="marca-i"></span>';
    h1.insertBefore(bloco, h1.firstChild);
    h1.classList.add('com-logo');

    this._logoNaPausa(url);
    this._temLogo = true;
    console.info('[Menu] logotipo:', url);
  }

  /**
   * A mesma marca no topo da tela de pausa, discreta.
   *
   * Reaproveita a URL que acabou de passar por `decode()`: o bitmap já está no
   * cache do navegador, então esta `<img>` não baixa nem decodifica de novo. E
   * é montada AGORA, no boot — nunca no momento em que o jogador aperta Esc —
   * então não existe pop-in nem salto de layout ao pausar. Sem brilho, sem
   * bloco ciano, sem halo: a pausa é tela de trabalho, não de vitrine.
   */
  _logoNaPausa(url) {
    const painel = this.elPausa?.querySelector('.painel');
    if (!painel) return;
    const marca = document.createElement('div');
    marca.className = 'marca-pausa';
    marca.innerHTML = `<img src="${url}" alt="Operação RIO-AGI">`;
    painel.insertBefore(marca, painel.firstChild);
  }

  /** Some com a camada estática do index.html assim que a arte real assumiu. */
  _encerrarPreCarga() {
    const pre = document.getElementById('pre-carga');
    if (!pre || this._preSaindo) return;
    this._preSaindo = true;
    pre.classList.add('sai');
    setTimeout(() => pre.remove(), 620);
  }

  /**
   * Revelação do título: o logo entra com peso, o brilho atravessa o metal, o
   * bloco ciano do "i" acende por último e o painel assenta atrás.
   *
   * Toda a coreografia está em abertura.css e vive presa à classe `revelando`.
   * O estado BASE da folha já é o estado FINAL — tirar a classe (pulo do
   * jogador, ou `prefers-reduced-motion`) devolve o menu pronto na hora, sem
   * meio-caminho travado.
   */
  _revelar() {
    if (this._jaRevelou) { this.mostrar('menu'); return; }
    this._jaRevelou = true;

    const semAnimacao = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    this.mostrar('menu');
    if (semAnimacao) return;

    this.raiz.classList.add('revelando');
    this._armarPulo();
    this._tRevelacao = setTimeout(() => this._encerrarRevelacao(), ABERTURA.duracao);
  }

  /**
   * Qualquer clique ou tecla corta a abertura. Quem abre o jogo pela décima vez
   * não pode ser obrigado a assistir.
   *
   * Em captura e na `window`: pega o evento antes de qualquer botão do menu. Os
   * botões estão com `pointer-events: none` durante a revelação (regra do
   * abertura.css), então este clique não dispara "Jogar" sem querer.
   */
  _armarPulo() {
    if (this._pular) return;
    this._pular = () => this._encerrarRevelacao();
    const opc = { capture: true, once: true };
    for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
      window.addEventListener(ev, this._pular, opc);
    }
  }

  _encerrarRevelacao() {
    clearTimeout(this._tRevelacao);
    this._tRevelacao = 0;
    this.raiz?.classList.remove('revelando');
    if (this._pular) {
      for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
        window.removeEventListener(ev, this._pular, { capture: true });
      }
      this._pular = null;
    }
    // devolve o foco ao primeiro botão, agora que ele já recebe ponteiro
    requestAnimationFrame(() => this.elMenu?.querySelector('.bt')?.focus?.());
  }

  /**
   * ESC volta um nível de cada vez.
   *
   *   folha aberta  -> fecha a folha e volta ao painel
   *   pausado       -> retoma a partida
   *   menu inicial  -> nada (não há para onde voltar)
   *
   * Durante o jogo o ESC sai do pointer lock sozinho e o navegador NÃO entrega
   * o keydown, por isso a pausa é disparada por `input:unlocked` e não aqui.
   */
  _ligarEscape() {
    this._onEsc = (ev) => {
      if (ev.code !== 'Escape') return;
      const folhaAberta = [...this.raiz.querySelectorAll('.folha')]
        .find((f) => f.style.display !== 'none');
      if (folhaAberta) {
        ev.preventDefault();
        this._acao('voltar');
        return;
      }
      if (this.telaAtual === 'pausa') {
        ev.preventDefault();
        this._acao('retomar');
      }
    };
    window.addEventListener('keydown', this._onEsc);
  }

  _abrirFolha(id) {
    // A folha e filha da tela do menu; quando pausado, move para a tela de pausa
    // para aparecer por cima do desfoque.
    const folha = this.raiz.querySelector(`#${id}`);
    if (!folha) return;
    const destino = this.telaAtual === 'pausa' ? this.elPausa : this.elMenu;
    if (folha.parentElement !== destino) destino.appendChild(folha);
    this._fecharFolhas();          // so uma folha aberta por vez
    folha.style.display = 'flex';
  }

  /**
   * Esconde por `style.display`, nao pelo atributo `hidden`: a regra
   * `.folha { display: flex }` do styles.css tem especificidade maior que o
   * `[hidden]` da folha de estilo do navegador e anularia o ocultamento.
   */
  _fecharFolhas() {
    for (const f of this.raiz.querySelectorAll('.folha')) f.style.display = 'none';
  }

  _preencherConfig() {
    const s = this.ctx.settings;
    for (const inp of this.raiz.querySelectorAll('input[type=range][data-cfg]')) {
      const id = inp.dataset.cfg;
      let v = s[id];
      if (id === 'sensitivity') v = +(v * 1000).toFixed(2);
      inp.value = v;
      const rot = this.raiz.querySelector(`#val-${id}`);
      if (rot) rot.textContent = v + (FAIXAS[id]?.sufixo ?? '');
    }
  }

  /* ------------------------------------------------------------------ */

  _ligarEventos() {
    const bus = this.ctx.bus;
    const on = (n, f) => this._offs.push(bus.on(n, f));

    on('boot:progress', ({ label, pct }) => {
      if (this.elPreenche) this.elPreenche.style.transform = `scaleX(${pct})`;
      if (this.elPct) this.elPct.textContent = `${Math.round(pct * 100)}%`;
      if (this.elRotulo) this.elRotulo.textContent = label;
    });

    on('boot:done', () => {
      // Rede de segurança: se a arte demorou, a pré-carga sai mesmo assim.
      this._encerrarPreCarga();
      // Pequeno atraso para a barra chegar a 100% visualmente antes de trocar.
      this._tAbertura = setTimeout(() => this._revelar(), ABERTURA.atrasoMenu);
    });

    on('player:died', () => {
      /* NAO escrevemos `ctx.state` aqui.
       *
       * Quem morre entra em 'caindo' (ver `Player._die`) e e a encenacao da
       * queda que devolve o estado para 'morto' ao terminar. Forcar 'morto'
       * neste ponto — como este bloco fazia — congelava o `Player.update` no
       * primeiro quadro e a queda nunca acontecia.
       *
       * E NAO soltamos o ponteiro aqui, tambem de proposito: soltar faz o
       * cursor do sistema aparecer na hora, e o jogador — ainda no impulso do
       * tiroteio, mexendo o mouse — passa a arrastar uma setinha por cima da
       * tela de morte. O lock segue ate a trava de `_travarMorte` liberar; e
       * ela quem chama `releaseLock` no fim da contagem. */
      this.ctx.hud?.setVisible?.(false);

      /* Rede de seguranca, nao o caminho normal.
       *
       * O caminho normal e `player:caiu`. Este prazo so existe para o caso de
       * a encenacao nao terminar (excecao no meio da queda, aba em segundo
       * plano com o rAF suspenso): sem ele o jogador ficaria olhando o proprio
       * cadaver para sempre, sem tela e sem botao. O valor e o teto da queda
       * (1,6 s) com folga. */
      clearTimeout(this._tQueda);
      this._tQueda = setTimeout(() => {
        if (this.telaAtual !== 'morte') {
          console.warn('[Menu] a queda nao avisou que terminou; abrindo a tela de morte');
          this.ctx.state = 'morto';
          this.mostrar('morte');
        }
      }, 2600);
    });

    /* Fim da encenacao da queda: agora sim a tela final.
     *
     * A trava de 5 s (`_travarMorte`) e disparada por `mostrar('morte')` e
     * continua sendo a unica dona da espera — a queda acontece ANTES dela e
     * nao mexe no relogio dela. O que mudou foi so QUANDO a tela entra: era um
     * prazo cego de 900 ms, agora e o fim da queda. */
    on('player:caiu', () => {
      clearTimeout(this._tQueda);
      this.ctx.state = 'morto';
      this.ctx.hud?.setVisible?.(false);
      this.mostrar('morte');
    });

    // Pausa por Escape. O pointerlock ja sai sozinho ao apertar Esc, entao
    // reagimos a saida do lock em vez da tecla — assim nao pausa duas vezes.
    on('input:unlocked', () => {
      if (this.ctx.state === 'jogando') {
        this.ctx.state = 'pausado';
        this.mostrar('pausa');
        this.ctx.bus.emit('game:pause', {});
      }
    });
  }

  /* ------------------------------------------------------------------ */

  /**
   * Segura os botoes da tela de morte por `ESPERA_MORTE` segundos.
   *
   * Alem de desabilitar, marca o botao com a classe que desenha a barra de
   * espera. `disabled` sozinho tambem impede Enter e Espaco de dispararem —
   * so mudar a aparencia deixaria o teclado furar a trava.
   */
  _travarMorte() {
    const botoes = [...(this.elMorte?.querySelectorAll('.bt') ?? [])];
    if (!botoes.length) return;
    clearTimeout(this._tMorte);
    this._morteLiberada = false;

    this.elMorte?.classList.add('travada');

    for (const b of botoes) {
      b.disabled = true;
      b.classList.remove('liberado');
      // Reinicia a animacao da barra: sem isto, morrer duas vezes seguidas
      // reaproveita a animacao ja terminada e a barra nasce cheia.
      b.classList.remove('travado');
      void b.offsetWidth;
      b.classList.add('travado');
      b.style.setProperty('--espera', ESPERA_MORTE + 's');
    }

    this._tMorte = setTimeout(() => {
      this._morteLiberada = true;
      this.elMorte?.classList.remove('travada');
      // So agora o cursor aparece: e este o instante em que ha o que clicar.
      this.ctx.input?.releaseLock?.();
      for (const b of botoes) {
        b.disabled = false;
        b.classList.remove('travado');
        b.classList.add('liberado');
      }
      // Foco so agora: focar um botao desabilitado nao funciona, e focar
      // depois evita que um Enter guardado dispare no meio da espera.
      botoes[0]?.focus?.();
    }, ESPERA_MORTE * 1000);
  }
  /** @param {'carga'|'menu'|'pausa'|'morte'|null} qual */
  mostrar(qual) {
    this._fecharFolhas();
    const mapa = { carga: this.elCarga, menu: this.elMenu, pausa: this.elPausa, morte: this.elMorte };
    for (const [nome, el] of Object.entries(mapa)) {
      el?.classList.toggle('ativa', nome === qual);
    }
    this.telaAtual = qual;
    if (qual === 'morte') this._travarMorte();
    // A marca da pausa desliza junto com o painel na PRIMEIRA vez da sessao e
    // fica parada nas seguintes: Esc se aperta dezenas de vezes por partida e
    // reanimar a mesma logo a cada vez cansa.
    if (qual === 'pausa') {
      if (this._pausaJaVista) this.elPausa?.classList.add('ja-vista');
      this._pausaJaVista = true;
    }
    // Foco no primeiro botao para navegacao por teclado.
    // Na tela de morte o foco e dado pelo `_travarMorte`, quando liberar.
    if (qual && qual !== 'carga' && qual !== 'morte') {
      requestAnimationFrame(() => mapa[qual]?.querySelector('.bt')?.focus?.());
    }
  }

  showMain() { this.mostrar('menu'); }
  hideAll() { this.mostrar(null); }

  update() { /* o menu e CSS puro; nada por frame */ }
  get pausable() { return false; }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
    if (this._onEsc) window.removeEventListener('keydown', this._onEsc);
    clearTimeout(this._tAbertura);
    clearTimeout(this._tQueda);
    clearTimeout(this._tMorte);
    this._encerrarRevelacao();
    this.raiz?.remove();
  }
}

/** Rotulos e sufixos dos controles deslizantes. */
const FAIXAS = {
  exposure: { rotulo: 'Exposição', sufixo: '' },
  filmGrain: { rotulo: 'Granulação', sufixo: '' },
  vignette: { rotulo: 'Vinheta', sufixo: '' },
  chromaticAberration: { rotulo: 'Aberração cromática', sufixo: '' },
  fov: { rotulo: 'Campo de visão', sufixo: '°' },
  sensitivity: { rotulo: 'Sensibilidade', sufixo: '' },
  adsSensitivityScale: { rotulo: 'Sensibilidade na mira', sufixo: '' },
  masterVolume: { rotulo: 'Volume geral', sufixo: '' },
  sfxVolume: { rotulo: 'Efeitos', sufixo: '' },
  musicVolume: { rotulo: 'Música', sufixo: '' },
};

export default Menu;
