/**
 * FXManager — orquestrador de efeitos visuais.
 *
 * Assina o EventBus e traduz eventos de jogo em particulas, decals, tracers e
 * luz. Nao decide nada de gameplay; so reage.
 *
 * Politica de alocacao: TUDO e pre-alocado no init(). Nenhum `new` no caminho
 * quente — um FPS que aloca por tiro engasga no GC exatamente na hora do
 * tiroteio, que e o pior momento possivel.
 */
import * as THREE from 'three';
import { PoolParticulas, PoolDestrocos, PoolCartuchos, criarAtlasParticulas, PT } from './Particles.js';
import { Decals, criarAtlasDecals, DECAL } from './Decals.js';
import { Tracers } from './Tracers.js';
import {
  receitaDe, claraoDe, FUMACA_CANO, SOPRO_CANO, FAISCAS_CANO,
} from './Impacts.js';

/* --- temporarios de modulo (zero alocacao por frame) --- */
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _cor = new THREE.Color();
/** Cor do pente/destroco escuro — pre-alocada (gera() espera THREE.Color). */
const COR_PENTE = new THREE.Color(0x18181a);

/** Quantas luzes de impacto/clarao podem existir ao mesmo tempo. */
const MAX_LUZES = 4;

export class FXManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.grupo = new THREE.Group();
    this.grupo.name = 'fx';
    this.grupo.matrixAutoUpdate = false;

    this.pools = { fumaca: null, brilho: null, destrocos: null, cartuchos: null };
    this.decals = null;
    this.tracers = null;

    this._luzes = [];        // pool de PointLight
    this._luzLivre = 0;
    this._tempo = 0;
    this._escala = 1;        // multiplicador de quantidade (preset)
    this._offs = [];         // desinscricoes do bus

    // Controle de fumaca de cano: acumula com a cadencia, esfria com o tempo.
    this._calor = 0;
    this._ultimoTiro = -999;
  }

  async init() {
    const ctx = this.ctx;
    const q = ctx.settings?.q ?? {};
    this._escala = q.particleScale ?? 1;

    /* --- atlas procedurais --- */
    const atlasPart = criarAtlasParticulas(q.textureSize >= 2048 ? 512 : 256);

    /* --- pools de particula ---
       Dois pools porque o modo de blend difere: fumaca/poeira sao alpha-blend
       ordenadas, faisca/clarao sao aditivas. Misturar os dois num pool so
       produz fumaca brilhando como brasa. */
    const capBase = Math.max(256, Math.round(2400 * this._escala));
    this.pools.fumaca = new PoolParticulas(capBase, atlasPart, {
      aditivo: false, nome: 'fx.fumaca', ordem: 0,
    });
    this.pools.brilho = new PoolParticulas(Math.round(capBase * 0.75), atlasPart, {
      aditivo: true, nome: 'fx.brilho', ordem: 1,
    });

    /* --- destrocos solidos (lascas, cacos, folhas) --- */
    const geoFrag = new THREE.TetrahedronGeometry(0.5, 0);
    const matFrag = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.85, metalness: 0.0, vertexColors: false,
    });
    this.pools.destrocos = new PoolDestrocos(Math.round(220 * this._escala), geoFrag, matFrag);

    /* --- cartuchos ejetados --- */
    const geoCart = new THREE.CylinderGeometry(0.0045, 0.005, 0.023, 8, 1);
    geoCart.rotateZ(Math.PI / 2);   // deita no eixo X (comprimento do estojo)
    const matCart = new THREE.MeshStandardMaterial({
      color: 0xc8a24a, roughness: 0.32, metalness: 0.95,   // latao
    });
    this.pools.cartuchos = new PoolCartuchos(
      Math.round(48 * this._escala), geoCart, matCart,
      (pos, forca) => this.ctx.audio?.cartucho?.(pos, forca),
    );

    for (const p of Object.values(this.pools)) if (p?.mesh) this.grupo.add(p.mesh);

    /* --- decals --- */
    this.decals = new Decals(ctx);
    await this.decals.init(criarAtlasDecals ? 256 : 256);
    if (this.decals.mesh) this.grupo.add(this.decals.mesh);

    /* --- tracers --- */
    this.tracers = new Tracers(q.maxTracers ?? 96);
    if (this.tracers.mesh) this.grupo.add(this.tracers.mesh);

    /* --- pool de luzes de disparo/impacto ---
       PointLight sem sombra: a sombra dinamica de um flash de 40ms nao paga o
       custo de reconstruir o shadow map, e ninguem percebe a falta.

       CRITICO: as luzes ficam SEMPRE `visible = true`, apagadas por
       `intensity = 0`. O three monta a chave de programa a partir da contagem
       de luzes VISIVEIS; acender a primeira no disparo mudaria a contagem e
       forcaria recompilacao de todos os materiais da cena — a travada de meio
       segundo no primeiro tiro. Com a contagem fixa desde o boot, nao ha
       recompilacao nenhuma em runtime. */
    for (let i = 0; i < MAX_LUZES; i++) {
      const l = new THREE.PointLight(0xffcc88, 0, 8, 2);
      l.castShadow = false;
      l.visible = true;
      l.intensity = 0;
      l.userData.ate = 0;
      l.userData.dur = 1;
      l.userData.pico = 0;
      l.userData.acesa = false;
      this._luzes.push(l);
      this.grupo.add(l);
    }

    ctx.scene.add(this.grupo);
    this._ligarEventos();

    // Pre-compila os programas de tudo que so aparece ao atirar (particulas,
    // decals, tracers, destrocos). Sem isso o primeiro tiro paga a compilacao.
    await this._preAquecer();
    return this;
  }

  /**
   * Aquece o pipeline: compila os shaders e sobe as texturas a GPU antes de o
   * jogo comecar, emitindo uma rajada minima fora do campo de visao.
   */
  async _preAquecer() {
    const ctx = this.ctx;
    const longe = new THREE.Vector3(0, -9000, 0);
    const dir = new THREE.Vector3(0, 1, 0);

    this.pools.fumaca?.emite(FUMACA_CANO, longe, dir, 1);
    this.pools.brilho?.emite(FAISCAS_CANO, longe, dir, 1);
    this.pools.fumaca?.flush(0);
    this.pools.brilho?.flush(0);
    // com `cor`: forca a alocacao do instanceColor agora. Sem isso o primeiro
    // pente caindo (weapon:magdrop) aloca um buffer de GPU no meio do tiroteio.
    this.pools.destrocos?.gera(longe, dir, -9010, { tam: 0.03, vida: 0.01, cor: COR_PENTE, giro: 5 });
    this.pools.cartuchos?.ejeta(longe, dir, -9010, 0.01);
    this.tracers?.dispara(longe, dir, 5, {});
    this.decals?.coloca(longe, dir, 0, 0.1, {});

    try {
      // compile() percorre a cena e gera todos os programas de uma vez
      if (ctx.renderer.compileAsync) {
        await ctx.renderer.compileAsync(ctx.scene, ctx.camera);
        if (ctx.viewScene) await ctx.renderer.compileAsync(ctx.viewScene, ctx.viewCamera);
      } else {
        ctx.renderer.compile(ctx.scene, ctx.camera);
        if (ctx.viewScene) ctx.renderer.compile(ctx.viewScene, ctx.viewCamera);
      }
    } catch (e) {
      console.warn('[FX] pre-aquecimento falhou (segue sem ele):', e);
    }

    this.reset();
  }

  /* --------------------------------------------------------------------- */
  /* Eventos                                                                */
  /* --------------------------------------------------------------------- */

  _ligarEventos() {
    const bus = this.ctx.bus;
    if (!bus) return;
    const on = (n, f) => this._offs.push(bus.on(n, f));

    on('weapon:fire', (p) => this._aoDisparar(p));
    on('weapon:hit', (p) => this._aoAcertar(p));
    on('weapon:eject', (p) => this._aoEjetar(p));
    on('weapon:magdrop', (p) => this._aoSoltarPente(p));
    on('enemy:fire', (p) => this._aoDisparar({ ...p, weapon: 'inimigo', doInimigo: true }));
    on('enemy:killed', (p) => this._aoMorrer(p));
    on('player:land', (p) => this._aoAterrissar(p));
  }

  /** Clarao + sopro + faiscas na boca do cano. */
  _aoDisparar({ origin, dir, weapon, doInimigo }) {
    if (!origin || !dir) return;
    const c = claraoDe(weapon);
    const mult = this._escala * (doInimigo ? 0.6 : 1);

    _v1.copy(origin);
    _v2.copy(dir).normalize();

    // Nucleo do clarao: duas particulas aditivas de vida muito curta, com
    // rotacao aleatoria para nao repetir a mesma estrela dois tiros seguidos.
    const flash = this.pools.brilho;
    _v3.set(0, 0, 0);
    flash.emiteUm(_v1, _v3, {
      atlas: Math.random() < 0.5 ? PT.FLASH_A : PT.FLASH_B,
      life: 0.045, drag: 0, grav: 0,
      tam0: 0.42 * c.escala, tam1: 0.30 * c.escala,
      rot: Math.random() * 6.283, rotVel: 0,
      cor: c.cor, brilho: 5.5, alpha: 1, fadeIn: 0, fadeOut: 1.0,
    });
    flash.emiteUm(_v1, _v3, {
      atlas: PT.GLOW,
      life: 0.06, drag: 0, grav: 0,
      tam0: 0.62 * c.escala, tam1: 0.22 * c.escala,
      cor: c.cor, brilho: 3.0, alpha: 0.9, fadeIn: 0, fadeOut: 1.2,
    });

    flash.emite(FAISCAS_CANO, _v1, _v2, mult);
    this.pools.fumaca.emite(SOPRO_CANO, _v1, _v2, mult);

    // Fumaca persistente: so aparece depois de alguns tiros seguidos, como
    // cano esquentando. Detalhe barato que le como "arma de verdade".
    this._calor = Math.min(1, this._calor + 0.16);
    this._ultimoTiro = this._tempo;
    if (this._calor > 0.3) {
      this.pools.fumaca.emite(FUMACA_CANO, _v1, _v2, this._calor * mult);
    }

    this._acenderLuz(_v1, c.cor, c.luz, c.dist, c.ms);
  }

  /** Particulas + decal no ponto de impacto. */
  _aoAcertar({ point, normal, surface, target }) {
    if (!point) return;
    const rec = receitaDe(surface);
    _v1.copy(point);
    _v2.copy(normal ?? _v3.set(0, 1, 0)).normalize();

    for (const cam of rec.camadas) this._emitirCamada(cam, _v1, _v2, this._escala);

    // Decal: afasta 1cm da face para nao brigar com o z-buffer da parede.
    if (rec.decal !== null && rec.decal !== undefined && this.decals) {
      const [tmin, tmax] = rec.decalTam;
      const tam = tmin + Math.random() * (tmax - tmin);
      // Sangue nao gruda no corpo (o corpo se move); so em geometria de mundo.
      if (!(surface === 'carne' && target === 'enemy')) {
        this.decals.coloca(_v1, _v2, rec.decal, tam, {
          roll: rec.decalRot ? Math.random() * 6.283 : 0,
        });
      }
    }

    if (rec.flash) {
      this._acenderLuz(_v1, rec.flash.cor, rec.flash.intensidade, rec.flash.distancia, rec.flash.ms);
    }

    /* O SOM do impacto NAO sai daqui.
     *
     * `AudioEngine._assina` ja tem `bus.on('weapon:hit', ...)` desde sempre, e
     * esta linha chamava `impacto()` de novo para o MESMO evento: medido em
     * 197 eventos -> 394 chamadas, a maior categoria de voz do jogo (prio 56)
     * dobrada em TODO tiro do jogo. Nao era so custo — era o impacto tocando
     * duas vezes o tempo inteiro.
     *
     * O dono e o AUDIO, e nao o FX, por dois motivos: ele ja assina o evento
     * direto do barramento (nao depende de o FX estar vivo nem de a qualidade
     * ter cortado particula), e som e o modulo dele. O FX aqui cuida do que e
     * visivel: particula, decal e o clarao do impacto. */
  }

  _aoEjetar({ position, direction, speed }) {
    if (!position || !this.pools.cartuchos) return;
    _v1.copy(position);
    _v2.copy(direction ?? _v3.set(1, 0.5, 0)).normalize().multiplyScalar(speed ?? 3);
    _v2.y += 0.8;
    const chao = this._chaoAbaixo(_v1);
    this.pools.cartuchos.ejeta(_v1, _v2, chao, 6);
  }

  _aoSoltarPente({ position }) {
    if (!position) return;
    // O pente caindo e um objeto grande: usa destrocos com escala maior.
    _v1.copy(position);
    _v2.set((Math.random() - 0.5) * 0.6, -0.4, (Math.random() - 0.5) * 0.6);
    const chao = this._chaoAbaixo(_v1);
    this.pools.destrocos?.gera(_v1, _v2, chao, {
      tam: 0.06, vida: 5, cor: COR_PENTE, giro: 5,
    });
  }

  _aoMorrer({ point }) {
    if (!point) return;
    _v1.copy(point);
    _v2.set(0, 1, 0);
    const rec = receitaDe('carne');
    for (const cam of rec.camadas) this._emitirCamada(cam, _v1, _v2, this._escala * 1.6);
  }

  _aoAterrissar({ velocity, surface }) {
    const v = Math.abs(velocity ?? 0);
    if (v < 3.5) return;
    const cam = this.ctx.camera;
    if (!cam) return;
    _v1.copy(cam.position); _v1.y -= 1.6;
    _v2.set(0, 1, 0);
    const rec = receitaDe(surface ?? 'terra');
    const poeira = rec.camadas.find((c) => c.pool === 'fumaca');
    if (poeira) {
      this.pools.fumaca.emite(poeira.receita, _v1, _v2, this._escala * Math.min(1.5, v / 6));
    }
  }

  /* --------------------------------------------------------------------- */
  /* Auxiliares                                                             */
  /* --------------------------------------------------------------------- */

  /**
   * Emite uma camada de receita no pool certo.
   *
   * Os pools tem APIs diferentes: PoolParticulas.emite(receita,...) dispara uma
   * rajada de uma vez, mas PoolDestrocos.gera(pos,vel,chao,opts) cria UM
   * fragmento solido por chamada. Chamar `emite` no pool de destrocos lancava
   * "pool.emite is not a function" a cada impacto em concreto, tijolo, madeira,
   * vidro e terra — ou seja, na maioria dos tiros.
   */
  _emitirCamada(cam, pos, normal, escala) {
    const pool = this.pools[cam.pool];
    if (!pool) return;
    const r = cam.receita;

    if (cam.pool !== 'destrocos') { pool.emite(r, pos, normal, escala); return; }

    const faixa = (v, d) => (Array.isArray(v) ? v[0] + Math.random() * (v[1] - v[0]) : (v ?? d));
    const n = Math.round(faixa(r.count, 4) * escala);
    const chao = this._chaoAbaixo(pos);
    for (let i = 0; i < n; i++) {
      const sp = faixa(r.speed, 4);
      _v3.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      _v3.multiplyScalar(r.spread ?? 0.5).add(normal).normalize().multiplyScalar(sp);
      _v3.y += (r.upBias ?? 0) * sp;
      _cor.setHex(r.cor ?? 0xffffff, THREE.SRGBColorSpace);
      pool.gera(pos, _v3, chao, {
        life: faixa(r.life, 0.8),
        escala: faixa(r.tam0, 0.04),
        cor: _cor,
      });
    }
  }

  /** Altura do chao logo abaixo de um ponto (para cartucho quicar). */
  _chaoAbaixo(pos) {
    const col = this.ctx.world?.collision;
    if (!col?.raycast) return pos.y - 1.6;
    _v3.set(0, -1, 0);
    const r = col.raycast(pos, _v3, 4);
    return r?.hit ? r.point.y : pos.y - 1.6;
  }

  /** Acende uma luz do pool por `ms` milissegundos. */
  _acenderLuz(pos, cor, intensidade, distancia, ms) {
    const l = this._luzes[this._luzLivre];
    this._luzLivre = (this._luzLivre + 1) % this._luzes.length;
    l.position.copy(pos);
    _cor.setHex(cor, THREE.SRGBColorSpace);
    l.color.copy(_cor);
    l.intensity = intensidade;
    l.distance = distancia;
    // `visible` permanece true o tempo todo (ver _preAquecer); apagar e por
    // intensity = 0, o que nao mexe na chave de programa.
    l.userData.dur = ms / 1000;
    l.userData.ate = this._tempo + l.userData.dur;
    l.userData.pico = intensidade;
    l.userData.acesa = true;
  }

  /** Dispara um tracer da boca do cano ate o ponto de impacto. */
  tracer(origem, dir, distancia, opts) {
    this.tracers?.dispara(origem, dir, distancia, opts);
  }

  /* --------------------------------------------------------------------- */

  update(dt, elapsed) {
    this._tempo = elapsed;

    // Esfriamento do cano
    if (elapsed - this._ultimoTiro > 0.35) {
      this._calor = Math.max(0, this._calor - dt * 0.9);
    }

    // Decaimento das luzes de disparo: cai rapido e nao-linear, como o
    // clarao real. Corte seco deixa um "pisca" perceptivel.
    for (const l of this._luzes) {
      if (!l.userData.acesa) continue;
      const restante = l.userData.ate - elapsed;
      if (restante <= 0) { l.userData.acesa = false; l.intensity = 0; continue; }
      // t vai de 1 (recem-acesa) a 0 (fim); expoente 2.2 concentra o brilho
      // no primeiro terco da vida, como polvora queimando.
      const t = restante / l.userData.dur;
      l.intensity = l.userData.pico * Math.pow(t, 2.2);
    }

    this.pools.destrocos?.update(dt);
    this.pools.cartuchos?.update(dt);
    this.decals?.update(dt);
    this.tracers?.update(dt);

    // flush envia a GPU so o intervalo escrito neste frame
    this.pools.fumaca?.flush(elapsed);
    this.pools.brilho?.flush(elapsed);
  }

  setQuality(preset) {
    this._escala = preset.particleScale ?? 1;
    this.decals?.setQuality(preset);
    this.tracers?.setQuality(preset);
  }

  /** Limpa tudo que esta em voo (usado ao reiniciar a partida). */
  reset() {
    this.pools.fumaca?.limpa();
    this.pools.brilho?.limpa();
    this.pools.destrocos?.limpa();
    this.pools.cartuchos?.limpa();
    this.decals?.limpa();
    this.tracers?.limpa();
    this._calor = 0;
    for (const l of this._luzes) { l.userData.acesa = false; l.intensity = 0; }
  }

  estatisticas() {
    return {
      fumaca: this.pools.fumaca?.conta(this._tempo) ?? 0,
      brilho: this.pools.brilho?.conta(this._tempo) ?? 0,
      decals: this.decals?.vivos ?? 0,
      tracers: this.tracers?.vivos ?? 0,
    };
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
    for (const p of Object.values(this.pools)) p?.dispose();
    this.decals?.dispose();
    this.tracers?.dispose();
    this.ctx.scene?.remove(this.grupo);
  }
}

export default FXManager;
