/**
 * OPERACAO CIDADE ALTA — bootstrap e loop principal.
 * Dono: CORE. Outros agentes nao editam este arquivo; se precisarem de um gancho,
 * registrem em NOTES.md.
 */
import * as THREE from 'three';
import { createContext } from './core/GameContext.js';
import { EventBus } from './core/EventBus.js';
import { Settings } from './core/Settings.js';
import { Input } from './core/Input.js';
import { Engine } from './core/Engine.js';
import { PostFX } from './core/PostFX.js';
import { Sky } from './core/Sky.js';
import { Lighting } from './core/Lighting.js';
import { MaterialLibrary } from './world/materials/MaterialLibrary.js';
import { World } from './world/World.js';
import { Player } from './player/Player.js';
import { AIManager } from './ai/AIManager.js';
import { Etiquetas } from './ai/Etiquetas.js';
import { Mochila } from './gameplay/Mochila.js';
import { Pickups } from './gameplay/Pickups.js';
import { Progressao } from './gameplay/Progressao.js';
import { Musica } from './gameplay/Musica.js';
import { FXManager } from './fx/FXManager.js';
import { AudioEngine } from './fx/AudioEngine.js';
import { HUD } from './ui/HUD.js';
import { Menu } from './ui/Menu.js';

const MAX_DT = 0.05; // 20fps piso — abaixo disso a simulacao desacelera em vez de estourar

/* Passo de redesenho na tela de morte.
 *
 * Com o jogador morto a cena esta CONGELADA: ninguem anda, a IA nao roda, a
 * camera nao mexe. Redesenhar 5,9 M de triangulos 60 vezes por segundo para
 * produzir o MESMO quadro e desperdicio puro, e foi o que a medicao apontou
 * como a causa do engasgo relatado — em `tools/telafinal.mjs`, o render valia
 * 13,4 dos 14,1 ms do quadro da tela de morte, contra 0,7 ms de TODO o resto
 * (overlay de DOM, audio, mundo, pos-processamento).
 *
 * 4 da ~15 Hz, que e mais que suficiente para uma imagem parada por tras de um
 * veu vermelho — e ainda mantem o pos-processamento vivo, entao a tela nao le
 * como travada. Congelar de vez (nunca redesenhar) foi descartado: em driver
 * que nao preserva o buffer de desenho o canvas pode piscar preto. */
const PASSO_MORTO = 4;

class Game {
  constructor() {
    this.ctx = createContext();
    this.systems = [];
    this._raf = 0;
    this._acc = 0;
  }

  async boot() {
    const ctx = this.ctx;
    const canvas = document.getElementById('game');

    ctx.bus = new EventBus();
    ctx.settings = new Settings(ctx.bus);
    ctx.input = new Input(canvas, ctx.bus);

    // --- Engine primeiro: cria renderer, cenas, cameras ---
    ctx.engine = new Engine(ctx, canvas);
    await ctx.engine.init();

    // Auto-deteccao de qualidade na primeira execucao
    if (!localStorage.getItem('oca:settings:v1')) {
      ctx.settings.setQuality(ctx.settings.autoDetect(ctx.renderer));
    }

    const progress = (label, pct) => ctx.bus.emit('boot:progress', { label, pct });

    // --- Sistemas, em ordem de dependencia ---
    progress('Gerando materiais', 0.05);
    ctx.materials = new MaterialLibrary(ctx);
    await ctx.materials.init();

    progress('Montando o céu', 0.25);
    ctx.sky = new Sky(ctx);
    await ctx.sky.init();

    ctx.lighting = new Lighting(ctx);
    await ctx.lighting.init();

    progress('Erguendo a favela', 0.35);
    ctx.world = new World(ctx);
    await ctx.world.init();

    progress('Preparando armamento', 0.65);
    ctx.player = new Player(ctx);
    await ctx.player.init();

    progress('Efeitos e áudio', 0.78);
    ctx.fx = new FXManager(ctx);
    await ctx.fx.init();

    ctx.audio = new AudioEngine(ctx);
    await ctx.audio.init();

    progress('Posicionando hostis', 0.88);
    ctx.ai = new AIManager(ctx);
    await ctx.ai.init();

    // Etiquetas de depuracao sobre a cabeca dos inimigos (tecla F3).
    ctx.etiquetas = new Etiquetas(ctx);
    await ctx.etiquetas.init();

    // Itens: drop de inimigo + suprimento dentro das casas.
    // Antes dos Pickups: eles consultam `ctx.mochila` ao coletar.
    ctx.mochila = new Mochila(ctx);
    ctx.pickups = new Pickups(ctx);
    await ctx.pickups.init();

    // Ondas, meta de abates e escalada de dificuldade.
    ctx.progressao = new Progressao(ctx);
    await ctx.progressao.init();

    // Trilha adaptativa (silenciosa se os MP3 nao estiverem em public/audio/musica/).
    ctx.musica = new Musica(ctx);
    await ctx.musica.init();

    progress('Pós-processamento', 0.94);
    ctx.postfx = new PostFX(ctx);
    await ctx.postfx.init();

    progress('Interface', 0.98);
    ctx.hud = new HUD(ctx);
    await ctx.hud.init();
    ctx.menu = new Menu(ctx);
    await ctx.menu.init();

    // Ordem de update. Sky/Lighting depois do player para a sombra seguir a camera.
    this.systems = [
      ctx.player, ctx.ai, ctx.progressao, ctx.world, ctx.fx, ctx.audio, ctx.pickups,
      ctx.sky, ctx.lighting, ctx.postfx, ctx.hud, ctx.etiquetas, ctx.musica,
    ].filter(Boolean);

    ctx.bus.on('quality:changed', ({ preset }) => {
      for (const s of this.systems) s.setQuality?.(preset);
      ctx.engine.setQuality?.(preset);
    });

    progress('Pronto', 1.0);
    ctx.bus.emit('boot:done', {});

    this._exposeTestHooks();
    this.start();
  }

  start() {
    this.ctx.clock.start();
    const tick = () => {
      this._raf = requestAnimationFrame(tick);
      this.frame();
    };
    this._raf = requestAnimationFrame(tick);
  }

  frame() {
    const ctx = this.ctx;
    const raw = ctx.clock.getDelta();
    const dtReal = Math.min(raw, MAX_DT);

    /* Camera lenta. A escala e escrita por quem encena (hoje, a queda da morte
     * em `src/player/QuedaMorte.js`) e multiplica o dt de TODOS os sistemas —
     * e por isso que a desaceleracao vale para camera, particulas e molas de
     * uma vez, em vez de cada um ter o seu proprio fator.
     *
     * `dtReal` continua disponivel em `ctx.time.dtReal`: quem conta tempo de
     * PAREDE (a duracao da encenacao, a barra de espera da tela de morte) tem
     * de ler dali, senao a camera lenta estica tambem a espera do jogador. */
    const escala = ctx.time.scale ?? 1;
    const dt = dtReal * escala;
    ctx.time.dtReal = dtReal;
    ctx.time.dt = dt;
    ctx.time.elapsed += dt;
    ctx.time.frame++;

    const running = ctx.state === 'jogando';
    // Durante a queda so anda o que a camera precisa: o Player (que move a
    // camera e o viewmodel) e o FX (poeira e particulas ja no ar terminam o
    // curso). IA, ondas e itens ficam parados — o jogador ja perdeu, ninguem
    // mais atira nele, e congelar o campo e o que barateia o quadro.
    const caindo = ctx.state === 'caindo';
    const morto = ctx.state === 'morto';

    for (const s of this.systems) {
      if (running) { s.update?.(dt, ctx.time.elapsed); continue; }
      if (caindo && (s === ctx.player || s === ctx.fx)) { s.update?.(dt, ctx.time.elapsed); continue; }
      // Sistemas de mundo/render seguem rodando pausados (ceu, audio, musica);
      // simulacao (player, ai, fx) congela.
      if (s.pausable === false) s.update?.(dt, ctx.time.elapsed);
    }
    if (!running) {
      /* Ceu e iluminacao ficam de fora na tela de morte: a camera esta parada,
       * o sol nao anda e as cascatas de sombra ja estao onde tem de estar.
       * O `Sky` regenera o mapa de ambiente a cada 96 quadros (um PMREM
       * inteiro), e isso e um PICO de quadro a cada 1,6 s numa tela em que
       * nada muda. Na queda os dois seguem, porque a camera esta viajando. */
      if (!morto) {
        ctx.sky?.update?.(dt, ctx.time.elapsed);
        ctx.lighting?.update?.(dt, ctx.time.elapsed);
      }
      ctx.hud?.update?.(dt, ctx.time.elapsed);
      ctx.postfx?.update?.(dt, ctx.time.elapsed);
    }

    // Ver PASSO_MORTO: a tela de morte redesenha a ~15 Hz em vez de 60.
    if (!morto || ctx.time.frame % PASSO_MORTO === 0) ctx.engine.render();
    ctx.input.endFrame();
  }

  /**
   * Ganchos para o agente critico tirar screenshots deterministicos.
   * Nao usado pelo jogo em si.
   */
  _exposeTestHooks() {
    const ctx = this.ctx;
    window.__game = {
      ctx,
      ready: true,
      /**
       * Posiciona a camera para uma foto reproduzivel.
       * Em vez de coordenadas absolutas (que caem dentro do morro, porque o
       * terreno vai de -3 a +36 m), a pose e ancorada num ponto de spawn valido
       * do mundo e orientada por yaw/pitch — nunca por lookAt, que herdaria o
       * `up` inclinado do CameraRig.
       *
       * @param {number} spawn indice do ponto de spawn (world.getSpawnPoints())
       * @param {number} yaw   graus, 0 = -Z (norte), cresce para leste
       * @param {number} pitch graus, negativo = olhando para baixo
       */
      poseAt(spawn, yaw = 0, pitch = 0, opts = {}) {
        ctx.state = opts.simulate ? 'jogando' : 'pausado';
        const pts = ctx.world?.getSpawnPoints?.() ?? [];
        const p = pts.length ? (pts[spawn % pts.length].position ?? pts[spawn % pts.length]) : null;
        const alturaOlho = opts.eye ?? 1.68;
        if (p) {
          ctx.camera.position.set(p.x, p.y + alturaOlho, p.z);
        } else {
          ctx.camera.position.set(0, 20, 0);
        }
        if (opts.offset) {
          ctx.camera.position.x += opts.offset[0];
          ctx.camera.position.y += opts.offset[1];
          ctx.camera.position.z += opts.offset[2];
        }
        ctx.camera.up.set(0, 1, 0);
        ctx.camera.rotation.set(
          pitch * Math.PI / 180, yaw * Math.PI / 180, 0, 'YXZ',
        );
        ctx.camera.updateMatrixWorld(true);
        if (opts.fov) { ctx.camera.fov = opts.fov; ctx.camera.updateProjectionMatrix(); }
        if (opts.hideViewmodel !== undefined) ctx.viewScene.visible = !opts.hideViewmodel;
        if (opts.hour !== undefined) ctx.sky?.setTimeOfDay?.(opts.hour);
        ctx.lighting?.update?.(0, ctx.time.elapsed);
      },

      /** Camera aerea: XZ livre, altura absoluta, olhando para um alvo. */
      poseAerea(pos, alvo, opts = {}) {
        ctx.state = 'pausado';
        ctx.camera.up.set(0, 1, 0);
        ctx.camera.rotation.set(0, 0, 0);
        ctx.camera.position.set(pos[0], pos[1], pos[2]);
        ctx.camera.lookAt(alvo[0], alvo[1], alvo[2]);
        ctx.camera.updateMatrixWorld(true);
        if (opts.fov) { ctx.camera.fov = opts.fov; ctx.camera.updateProjectionMatrix(); }
        if (opts.hideViewmodel !== undefined) ctx.viewScene.visible = !opts.hideViewmodel;
        if (opts.hour !== undefined) ctx.sky?.setTimeOfDay?.(opts.hour);
        ctx.lighting?.update?.(0, ctx.time.elapsed);
      },

      /** Quantos pontos de spawn o mundo publicou (para gerar a lista de tomadas). */
      spawnCount() { return (ctx.world?.getSpawnPoints?.() ?? []).length; },
      setQuality(q) { ctx.settings.setQuality(q); },
      /** Renderiza N frames seguidos (deixa TAA/bloom convergirem antes da foto). */
      settle(n = 12) {
        for (let i = 0; i < n; i++) { ctx.engine.render(); }
      },
      stats() {
        const info = ctx.renderer.info;
        return {
          drawCalls: info.render.calls, triangles: info.render.triangles,
          geometries: info.memory.geometries, textures: info.memory.textures,
          programs: info.programs?.length ?? 0,
        };
      },
    };
  }
}

const game = new Game();
game.boot().catch((err) => {
  console.error('[boot] falhou:', err);
  const el = document.getElementById('ui-root');
  if (el) {
    /* A moldura e literal; o texto do erro entra por textContent. Uma pilha de
     * excecao pode conter marcacao (URL, nome de arquivo, trecho de codigo), e
     * jogar isso em innerHTML transforma a tela de erro num ponto de injecao —
     * justo a tela que aparece quando algo ja deu errado. */
    el.innerHTML = `<div style="position:fixed;inset:0;display:grid;place-items:center;
      background:#0b0b0d;color:#e8e2d8;font:14px/1.6 ui-monospace,monospace;padding:2rem;text-align:left">
      <div><strong style="color:#e05a3a">Falha ao iniciar</strong>
      <pre style="white-space:pre-wrap;max-width:70ch;opacity:.8"></pre></div></div>`;
    const pre = el.querySelector('pre');
    if (pre) pre.textContent = String(err?.stack || err);
  }
  window.__game = { ready: false, error: String(err?.stack || err) };
});
