/**
 * Etiquetas de depuracao sobre a cabeca de cada inimigo.
 *
 * Mostra id, estado da IA, vida e a altura do quadril. Serve para responder na
 * hora perguntas como "isso e um inimigo so ou dois sobrepostos?" e "essa perna
 * andando pertence a qual id?".
 *
 * Arquivo separado de propósito: nao mexe em Enemy/AIManager/Soldier.
 * Liga e desliga com a tecla F3.
 */
import * as THREE from 'three';

const LARG = 256, ALT = 64;

/** Uma etiqueta = um Sprite com CanvasTexture propria. */
class Etiqueta {
  constructor() {
    this.cv = document.createElement('canvas');
    this.cv.width = LARG; this.cv.height = ALT;
    this.g2d = this.cv.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.cv);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.generateMipmaps = false;
    this.mat = new THREE.SpriteMaterial({
      map: this.tex, transparent: true, depthTest: false, depthWrite: false,
      sizeAttenuation: false,   // tamanho constante na tela
    });
    this.sprite = new THREE.Sprite(this.mat);
    this.sprite.scale.set(0.16, 0.04, 1);
    this.sprite.renderOrder = 999;
    this.sprite.frustumCulled = false;
    this.sprite.visible = false;
    this._texto = null;
  }

  /** Redesenha so quando o texto muda — CanvasTexture e cara de subir. */
  escrever(texto, cor) {
    if (texto === this._texto) return;
    this._texto = texto;
    const g = this.g2d;
    g.clearRect(0, 0, LARG, ALT);
    g.fillStyle = 'rgba(0,0,0,0.62)';
    g.fillRect(0, 0, LARG, ALT);
    g.fillStyle = cor;
    g.fillRect(0, 0, 4, ALT);
    g.font = 'bold 26px ui-monospace, Consolas, monospace';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.fillText(texto, 12, ALT / 2);
    this.tex.needsUpdate = true;
  }

  dispose() {
    this.tex.dispose(); this.mat.dispose();
    this.sprite.removeFromParent();
  }
}

const CHAVE = 'oca:etiquetas';

/* Temporarios do painel de coordenadas. O projeto nao aloca por quadro:
 * objeto literal criado a 60 Hz vira pressao de GC e engasgo no tiroteio. */
const _coordOrig = new THREE.Vector3();
const _coordBaixo = new THREE.Vector3(0, -1, 0);
/* O painel nao precisa de 60 Hz: reescrever textContent forca layout. 10 Hz
 * ja e mais rapido do que o olho consegue ler. */
const PERIODO_COORD = 0.1;

export class Etiquetas {
  static _carregar() {
    try { return localStorage.getItem(CHAVE) === '1'; } catch { return false; }
  }

  static _salvar(v) {
    try { localStorage.setItem(CHAVE, v ? '1' : '0'); } catch { /* ignora */ }
  }

  constructor(ctx) {
    this.ctx = ctx;
    // Lembra entre partidas e entre recarregamentos da pagina.
    this.ativo = Etiquetas._carregar();
    this.grupo = new THREE.Group();
    this.grupo.name = 'debug.etiquetas';
    this.pool = [];
    this._v = new THREE.Vector3();
    this.pausable = false;   // continua desenhando com o jogo pausado
  }

  async init() {
    this.ctx.scene.add(this.grupo);
    this._criarPainel();
    this._onKey = (ev) => {
      if (ev.code === 'F3') {
        this.ativo = !this.ativo;
        Etiquetas._salvar(this.ativo);
        ev.preventDefault();
      }
      if (ev.code === 'F4') { this._dump(); ev.preventDefault(); }
      if (ev.code === 'F5') { this._identificarNaMira(); ev.preventDefault(); }
      if (ev.code === 'F6') { this._dumpConfig(); ev.preventDefault(); }
    };
    window.addEventListener('keydown', this._onKey);
    this._ligarLog();
    return this;
  }

  /* ------------------------------------------------------------------ */
  /* Log de acertos                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Registra no console cada acerto, dano e morte, com o id do inimigo e a
   * vida restante. Como o inimigo agora nasce a ~14 m, da para reproduzir o
   * bug em poucos segundos e copiar o log inteiro.
   */
  _ligarLog() {
    const bus = this.ctx.bus;
    if (!bus) return;
    this.historico = [];
    const reg = (linha) => {
      this.historico.push(linha);
      if (this.historico.length > 400) this.historico.shift();
      console.log('%c[TIRO] ' + linha, 'color:#e8873c');
    };

    bus.on('weapon:hit', (p) => {
      if (p?.target !== 'enemy') return;
      const e = this.ctx.ai?.pool?.find((x) => x.id === p.enemyId);
      reg(`acertou #${p.enemyId} superficie=${p.surface} `
        + `vida=${e ? Math.round(e.vida) : '?'} estado=${e ? e.estado : '?'} `
        + `mortoAntes=${e ? e.morto : '?'}`);
    });

    bus.on('enemy:damaged', (p) => {
      const e = this.ctx.ai?.pool?.find((x) => x.id === p.enemyId);
      reg(`dano   #${p.enemyId} ${p.damage.toFixed(0)} ${p.headshot ? 'CABECA' : ''} `
        + `-> vida ${e ? Math.round(e.vida) : '?'}`);
    });

    bus.on('enemy:killed', (p) => {
      reg(`MORREU #${p.enemyId} ${p.headshot ? '(cabeca)' : ''}`);
      this._dump();
    });
  }

  /**
   * Aponte a mira no objeto misterioso e aperte F5.
   *
   * Lança um raio pelo centro da tela contra a cena INTEIRA (não só inimigos)
   * e imprime o que atingiu, com a cadeia de pais completa. É o jeito direto
   * de descobrir a que pertence uma malha que não recebe etiqueta.
   */
  _identificarNaMira() {
    const ctx = this.ctx;
    const ray = this._ray || (this._ray = new THREE.Raycaster());
    ray.far = 200;
    ray.camera = ctx.camera;
    const dir = new THREE.Vector3();
    ctx.camera.getWorldDirection(dir);
    ray.set(ctx.camera.position, dir);

    const hits = ray.intersectObject(ctx.scene, true).filter((h) => h.object.visible);
    console.group('%c[MIRA] ' + hits.length + ' objeto(s) na linha de visada',
      'color:#e8873c;font-weight:bold');
    for (const h of hits.slice(0, 6)) {
      const cadeia = [];
      for (let o = h.object; o; o = o.parent) {
        cadeia.push(`${o.name || o.type}${o.visible ? '' : '(oculto)'}`);
      }
      // A que inimigo pertence, se pertencer a algum?
      let dono = 'NENHUM inimigo do pool';
      for (const e of ctx.ai?.pool ?? []) {
        let o = h.object;
        while (o) { if (o === e.soldado.grupo) { dono = `#${e.id} ativo=${e.ativo} morto=${e.morto}`; break; } o = o.parent; }
        if (dono !== 'NENHUM inimigo do pool') break;
      }
      console.log(
        `${h.distance.toFixed(2)} m | ${h.object.type} "${h.object.name || '(sem nome)'}"`
        + ` | material="${h.object.material?.name || '?'}"`
        + `\n   dono: ${dono}`
        + `\n   cadeia: ${cadeia.join(' < ')}`,
        h.object,
      );
    }
    console.groupEnd();
    return hits;
  }

  /**
   * Despeja as configurações atuais já no formato do bloco DEFAULTS de
   * `src/core/Settings.js`. Serve para promover o ajuste que o jogador fez a
   * padrão do jogo: aperte F6, copie o bloco e cole no arquivo.
   */
  _dumpConfig() {
    const s = this.ctx.settings;
    if (!s) return;
    const chaves = [
      'quality', 'sensitivity', 'adsSensitivityScale', 'fov', 'invertY',
      'masterVolume', 'sfxVolume', 'musicVolume',
      'showFps', 'crosshair', 'filmGrain', 'chromaticAberration', 'vignette', 'exposure',
    ];
    const linhas = chaves.map((k) => {
      const v = s[k];
      return `  ${k}: ${typeof v === 'string' ? `'${v}'` : v},`;
    });
    console.log('%c[CONFIG ATUAL] cole em src/core/Settings.js -> DEFAULTS',
      'color:#5fd08a;font-weight:bold');
    console.log('const DEFAULTS = {\n' + linhas.join('\n') + '\n};');
    return linhas;
  }

  /** Estado completo de todo o pool — pressione F4 a qualquer momento. */
  _dump() {
    const pool = this.ctx.ai?.pool ?? [];
    const ativos = pool.filter((e) => e.ativo);
    const visiveis = pool.filter((e) => e.soldado.grupo.visible);
    console.group('%c[ESTADO DA IA] ' + ativos.length + ' ativo(s), '
      + visiveis.length + ' visivel(is), de ' + pool.length,
      'color:#5fd08a;font-weight:bold');

    // Inativos que continuam sendo desenhados: malha orfa.
    for (const e of pool) {
      if (!e.ativo && e.soldado.grupo.visible) {
        console.warn(`#${e.id} INATIVO MAS VISIVEL — malha orfa em `
          + `(${e.pos.x.toFixed(1)},${e.pos.y.toFixed(1)},${e.pos.z.toFixed(1)})`);
      }
    }
    // Soldados na cena que nao sao do pool.
    const doPool = new Set(pool.map((e) => e.soldado.grupo));
    this.ctx.scene?.traverse((o) => {
      if (o.name === 'soldado' && !doPool.has(o)) {
        console.warn('SOLDADO FORA DO POOL na cena, visivel =', o.visible, o);
      }
    });

    for (const e of ativos) {
      const s = e.soldado;
      s.grupo.updateMatrixWorld(true);
      const q = s.porNome?.quadril, c = s.porNome?.cabeca;
      const vq = new THREE.Vector3(), vc = new THREE.Vector3();
      q?.getWorldPosition(vq); c?.getWorldPosition(vc);
      console.log(
        `#${e.id} ${e.morto ? 'MORTO' : e.estado.padEnd(9)} vida=${Math.round(e.vida)}`
        + ` pos=(${e.pos.x.toFixed(1)},${e.pos.y.toFixed(1)},${e.pos.z.toFixed(1)})`
        + ` quadrilY=${vq.y.toFixed(2)} cabecaY=${vc.y.toFixed(2)}`
        + ` dQC=${vc.distanceTo(vq).toFixed(2)}m`
        + ` grupoVis=${s.grupo.visible} malhaVis=${s.malha.visible}`
        + ` ragdoll=${e.ragdoll ? 'sim' : 'nao'}`,
      );
    }
    console.groupEnd();
  }


  /* ------------------------------------------------------------------ */
  /* Painel de coordenadas                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Leitura de posicao do jogador, ligada junto com as etiquetas (F3).
   *
   * PORQUE existe: quando alguem relata "fiquei preso" ou "tem um buraco
   * aqui", a primeira pergunta e ONDE. Sem coordenada na tela a resposta e
   * "perto de uma casa amarela", que nao reproduz. Com X/Y/Z da para ir direto
   * ao ponto com `__game.poseAt` ou com as ferramentas de tools/.
   *
   * O Y aparece DUAS vezes de proposito: `pos.y` sao os PES (o que importa
   * para altura de terreno, degrau e queda) e o olho fica 1,68 m acima. Confundir
   * os dois ja rendeu diagnostico errado aqui.
   *
   * E um overlay de DOM, nao um sprite 3D: texto pequeno em sprite fica ilegivel,
   * e este painel precisa ser copiavel a olho para virar bug report.
   */
  _criarPainel() {
    const host = document.getElementById('ui-root') || document.body;
    const el = document.createElement('div');
    el.id = 'debug-coord';
    el.style.cssText = [
      'position:fixed', 'top:8px', 'left:50%', 'transform:translateX(-50%)',
      'z-index:60', 'padding:6px 12px', 'border-radius:5px',
      'background:rgba(10,11,13,.72)', 'border:1px solid #2a2d33',
      'color:#e9e5db', 'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace',
      'white-space:pre', 'pointer-events:none', 'display:none',
    ].join(';');
    host.appendChild(el);
    this._painelCoord = el;
  }

  /** Atualiza o painel. Chamado so com as etiquetas ligadas. */
  _atualizarCoord(dt) {
    const el = this._painelCoord;
    if (!el) return;
    this._tCoord = (this._tCoord ?? 9) + (dt || 0.016);
    if (this._tCoord < PERIODO_COORD) return;
    this._tCoord = 0;
    const jog = this.ctx.player;
    if (!jog?.position) { el.textContent = 'sem jogador'; return; }

    const p = jog.position;                    // pes
    const olhoY = jog.eyePosition?.y ?? (p.y + 1.68);
    const yaw = jog.rig?.yaw ?? 0;
    // yaw -> graus de bussola. Convencao medida em tools/yaw.mjs:
    // direcao(yaw) = (-sin, 0, -cos), com 0 = norte (-Z).
    const grau = ((yaw * 180 / Math.PI) % 360 + 360) % 360;

    // Chao sob os pes: revela buraco de terreno e degrau alto sem sair do lugar.
    let chao = null, sup = '';
    const col = this.ctx.world?.collision;
    if (col?.groundAt) {
      const y = col.groundAt(p.x, p.z, 200);
      if (Number.isFinite(y)) chao = y;
    }
    if (col?.raycast) {
      // De 2 m acima dos pes, 6 m para baixo: pega o piso mesmo em laje.
      _coordOrig.set(p.x, p.y + 2, p.z);
      const r = col.raycast(_coordOrig, _coordBaixo, 6);
      if (r?.hit) sup = r.surface ?? '';
    }

    const f = (v) => (v >= 0 ? ' ' : '') + v.toFixed(2);
    el.textContent =
      `X ${f(p.x)}   Y ${f(p.y)}   Z ${f(p.z)}
` +
      `olho Y ${f(olhoY)}   rumo ${grau.toFixed(0).padStart(3, '0')}°` +
      (chao === null ? '' : `   chão ${f(chao)}${sup ? ' · ' + sup : ''}`);
  }

  _pegar(i) {
    let e = this.pool[i];
    if (!e) { e = new Etiqueta(); this.pool[i] = e; this.grupo.add(e.sprite); }
    return e;
  }

  update(dt) {
    if (!this.ativo) {
      if (this.grupo.visible) this.grupo.visible = false;
      if (this._painelCoord) this._painelCoord.style.display = 'none';
      return;
    }
    this.grupo.visible = true;
    if (this._painelCoord) this._painelCoord.style.display = 'block';
    this._atualizarCoord(dt);

    const ai = this.ctx.ai;
    let n = 0;

    /* 1) TODO o pool — inclusive inativos. Um inimigo inativo deveria estar
     *    invisivel; se aparecer etiqueta INATIVO em cima de algo que voce ve
     *    na tela, e uma malha que ficou orfa (despawn nao escondeu). */
    const vistos = new Set();
    for (const inim of ai?.pool ?? []) {
      const sold = inim.soldado;
      vistos.add(sold.grupo);
      // so etiqueta o que esta de fato visivel na cena
      if (!sold.grupo.visible) continue;
      const et = this._pegar(n++);
      sold.grupo.updateMatrixWorld(true);

      const osso = sold.porNome?.cabeca;
      if (osso) osso.getWorldPosition(this._v);
      else this._v.copy(inim.pos).setY(inim.pos.y + 1.7);
      this._v.y += 0.34;
      et.sprite.position.copy(this._v);

      const vida = Math.max(0, Math.round(inim.vida ?? 0));
      const cor = !inim.ativo ? '#ff2fd0'
        : (inim.morto ? '#d8281a' : (vida < 40 ? '#e8873c' : '#5fd08a'));
      const rot = !inim.ativo ? 'INATIVO-VISIVEL'
        : (inim.morto ? 'MORTO' : inim.estado);
      et.escrever(`#${inim.id} ${rot} ${vida}hp`, cor);
      et.sprite.visible = true;
    }

    /* 2) Qualquer malha de soldado na cena que NAO pertenca ao pool.
     *    Se a perna solta ganhar etiqueta ORFA, o problema e uma malha
     *    duplicada que nunca foi removida da cena. */
    this.ctx.scene?.traverse((o) => {
      // Qualquer malha com esqueleto, ou qualquer coisa com nome de soldado,
      // que nao pertenca a um grupo do pool.
      const pareceSoldado = o.isSkinnedMesh || (o.name && o.name.startsWith('soldado'));
      if (!pareceSoldado || !o.visible) return;
      let a = o, doPool = false;
      while (a) { if (vistos.has(a)) { doPool = true; break; } a = a.parent; }
      if (doPool) return;
      const et = this._pegar(n++);
      o.getWorldPosition(this._v);
      this._v.y += 2.0;
      et.sprite.position.copy(this._v);
      et.escrever(`ORFA ${o.name || o.type}`, '#ff2fd0');
      et.sprite.visible = true;
    });

    for (let i = n; i < this.pool.length; i++) this.pool[i].sprite.visible = false;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey);
    for (const e of this.pool) e.dispose();
    this.pool.length = 0;
    this.ctx.scene?.remove(this.grupo);
  }
}

export default Etiquetas;
