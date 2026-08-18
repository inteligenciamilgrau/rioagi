/**
 * enxame.mjs — o que o enxame custa, e como ele aparece.
 *
 * Três medidas e três capturas, todas com a onda temática de drone EM CAMPO —
 * que é a condição em que tudo isto pode estourar:
 *
 *   1. FPS      quadro a quadro, com o laço de render de verdade (rAF), não
 *               com `ai.update` num laço síncrono. Draw calls e triângulos.
 *   2. ÁUDIO    descarte de voz do `AudioEngine` com o enxame zumbindo e
 *               atirando. O motor tem teto de 48 vozes posicionadas e um
 *               critério de prioridade recém-medido; enxame é exatamente o
 *               caso que pode derrubar esse orçamento.
 *   3. CAPTURAS drone de perto (a fenda ciano tem de ler), enxame no morro,
 *               e o drone no mapa do TAB.
 *
 * ARMADILHA JÁ PAGA: a primeira captura sempre sai com o menu por cima. Aqui a
 * primeira é descartada de propósito.
 *
 * Uso: node tools/enxame.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 5285);
const OUT = ROOT + '/shots/drone';
mkdirSync(OUT, { recursive: true });

const vite = spawn(process.execPath, [
  ROOT + '/node_modules/vite/bin/vite.js',
  '--config', 'tools/vite.diag.config.js',
  '--host', '127.0.0.1', '--port', String(PORT), '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r, j) => {
  const t = setTimeout(() => j(new Error('timeout vite')), 60000);
  vite.stdout.on('data', (d) => { if (/ready in|Local:/i.test(String(d))) { clearTimeout(t); r(); } });
});

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERR:', String(e).split('\n')[0]));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text().split('\n')[0].slice(0, 180)); });
await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready, undefined, { timeout: 240000 });
await page.mouse.click(640, 360);
await page.waitForTimeout(1500);

/* ===================================================================== *
 * 0. Referência: FPS SEM drone nenhum                                    *
 * ===================================================================== */
const prepara = async () => page.evaluate(() => {
  const ctx = window.__game.ctx;
  ctx.state = 'jogando';
  ctx.menu?.hideAll?.();
  ctx.settings.set('musicVolume', 0);
  ctx.settings.set('sfxVolume', 1);
  ctx.ai.reset();
  ctx.ai.spawnAutomatico = false;

  /* JOGADOR INVULNERÁVEL, e isto é obrigatório aqui.
   *
   * ARMADILHA (NOTES [AI], seção 6, item 2): `Player._die()` põe
   * `ctx.state = 'morto'` e o respawn NÃO desfaz — quem desfaz é o menu. Numa
   * medição longa a primeira morte congela tudo. E há um efeito pior e mais
   * silencioso: com o jogador morto, `alvo.alive === false`, e TODO drone cai
   * em PATRULHA no primeiro quadro. A passagem anterior desta ferramenta mediu
   * exatamente isso sem perceber — 6 de 8 drones "patrulhando" no meio da onda
   * temática, 2 pedidos de voz em 15 s de áudio e ZERO drone no mapa do TAB.
   * Os três números pareciam três defeitos diferentes; era um só, e era do
   * instrumento.
   *
   * O dano continua sendo CONTABILIZADO; só não é aplicado. */
  const jog = ctx.player;
  if (!window.__danoTomado) window.__danoTomado = 0;
  if (!jog.__blindado) {
    const orig = jog.takeDamage.bind(jog);
    jog.takeDamage = function (d) { window.__danoTomado += d; return jog.health; };
    jog.__blindado = orig;
  }
  jog.alive = true;
  jog.health = jog.maxHealth;
});

/** Amostra o tempo de quadro pelo rAF durante `seg` segundos. */
const medeFps = (seg) => page.evaluate((seg) => new Promise((res) => {
  const dts = [];
  let ant = performance.now();
  const t0 = ant;
  const passo = () => {
    const t = performance.now();
    dts.push(t - ant);
    ant = t;
    if (t - t0 < seg * 1000) requestAnimationFrame(passo);
    else {
      dts.sort((a, b) => a - b);
      const info = window.__game.ctx.renderer.info;
      res({
        quadros: dts.length,
        msMed: +dts[dts.length >> 1].toFixed(2),
        msP95: +dts[Math.floor(dts.length * 0.95)].toFixed(2),
        msMax: +dts[dts.length - 1].toFixed(2),
        fpsMed: +(1000 / dts[dts.length >> 1]).toFixed(1),
        drawCalls: info.render.calls,
        triangulos: info.render.triangles,
        programas: info.programs?.length ?? 0,
      });
    }
  };
  requestAnimationFrame(passo);
}), seg);

await prepara();
const fpsVazio = await medeFps(6);

/* --- onda 3: o enxame --------------------------------------------------- */
const montagem = await page.evaluate(() => {
  const ctx = window.__game.ctx;
  const prog = ctx.progressao;
  const ai = ctx.ai;
  ctx.state = 'jogando';
  prog.reiniciar();
  // pula direto para a onda temática
  prog.onda = 2;
  prog.fase = 'intervalo';
  prog.tFase = 0;
  prog.update(1 / 60);
  ai.maxVivos = prog.simultaneosDaOnda(3);
  ai.maxDrones = prog.dronesDaOnda(3);
  ai.maxAtiradores = prog.atiradoresDaOnda(3);
  const perfil = prog.perfilDaOnda(3);
  for (const e of ai.pool) e.dif = perfil;
  const feitos = ai.spawnOnda(ai.maxDrones, 18, 46, 'drone');
  ai.convergirNoJogador(1.2);
  return {
    onda: prog.onda, rotulo: prog.rotuloOnda, meta: prog.meta,
    simultaneos: ai.maxVivos, drones: ai.maxDrones, atiradores: ai.maxAtiradores,
    nasceram: feitos,
  };
});
await page.waitForTimeout(3500);   // deixa o enxame chegar
const fpsEnxame = await medeFps(8);

/* ===================================================================== *
 * 2. ÁUDIO — descarte de voz com o enxame em campo                       *
 * ===================================================================== */
const audio = await page.evaluate(async () => {
  const ctx = window.__game.ctx, A = ctx.audio;
  const esperar = (s) => new Promise((r) => setTimeout(r, s * 1000));

  let pedidos = 0, negados = 0;
  const porTipo = {};
  const _vozOrig = A._voz.bind(A);
  A._voz = (pos, o = {}) => {
    pedidos++;
    const r = _vozOrig(pos, o);
    const k = 'prio' + (o.prio ?? 0);
    porTipo[k] = porTipo[k] || { pediu: 0, negou: 0 };
    porTipo[k].pediu++;
    if (!r) { negados++; porTipo[k].negou++; }
    return r;
  };

  // travadas da thread de áudio (mesmo detector do audiodiag.mjs)
  let travadas = 0, audioPerdido = 0, maxLacuna = 0;
  let lw = performance.now(), la = A.actx.currentTime;
  const amostra = setInterval(() => {
    const w = performance.now(), a = A.actx.currentTime;
    const dw = (w - lw) / 1000, da = a - la;
    lw = w; la = a;
    if (dw > 0.004) {
      const lacuna = dw - da;
      if (lacuna > dw * 0.30 && lacuna > 0.006) {
        travadas++; audioPerdido += lacuna;
        if (lacuna > maxLacuna) maxLacuna = lacuna;
      }
    }
  }, 8);

  const t0w = performance.now(), t0a = A.actx.currentTime;
  const serieVozes = [];
  for (let s = 0; s < 15; s++) { await esperar(1); serieVozes.push(A.vozes); }
  clearInterval(amostra);
  const wall = (performance.now() - t0w) / 1000;
  const aud = A.actx.currentTime - t0a;

  const est = A.estatisticas();
  A._voz = _vozOrig;
  return {
    pedidos, negados,
    descartePct: +(100 * negados / Math.max(1, pedidos)).toFixed(0),
    porTipo, serieVozes,
    travadas, audioPerdidoMs: +(audioPerdido * 1000).toFixed(0),
    maxLacunaMs: +(maxLacuna * 1000).toFixed(1),
    derivaMs: +((wall - aud) * 1000).toFixed(0),
    pool: est.pool, roubos: est.roubos, reaproveitados: est.reaproveitados,
    enxameMontado: !!A._enxNos,
    dronesEmCampo: ctx.ai.contarDrones(),
  };
});

/* ===================================================================== *
 * 3. CAPTURAS                                                            *
 * ===================================================================== */
const esconder = () => page.evaluate(() => {
  const ctx = window.__game.ctx;
  ctx.menu?.hideAll?.();
  ctx.hud?.setVisible?.(false);
  ctx.viewScene.visible = false;
});

// primeira captura é lixo por contrato (o menu ainda está por cima)
await esconder();
await page.screenshot({ path: OUT + '/00-descartada.png' });

/* --- 3a. enxame no morro, visto de dentro da viela --- */
const enxameInfo = await page.evaluate(() => {
  const ctx = window.__game.ctx;
  const drones = ctx.ai.getEnemies().filter((e) => e.eDrone);
  if (!drones.length) return { n: 0 };

  /* Enquadra pelos drones QUE SE VEEM, não pelo centroide de todos.
   *
   * O centroide de um enxame espalhado pelo morro cai, com frequência, dentro
   * de uma casa — e a foto "do enxame" saiu sendo a foto de uma parede de
   * tijolo com um drone do tamanho de um mosquito no canto. Filtrando por linha
   * de visada primeiro, a câmera aponta para onde o combate de fato está. */
  const jog = ctx.player.position;
  const olho = ctx.player.eyePosition;
  const col = ctx.world.collision;
  const V = ctx.camera.position.constructor;
  const visiveis = drones.filter((d) => {
    const dir = new V().subVectors(d.pos, olho);
    const dist = dir.length();
    if (dist < 1 || dist > 45) return false;
    dir.divideScalar(dist);
    const r = col.raycast(olho, dir, dist - 0.6);
    return !(r && r.hit);
  });
  const usar = visiveis.length >= 2 ? visiveis : drones;
  const c = usar.reduce((a, d) => { a.x += d.pos.x; a.y += d.pos.y; a.z += d.pos.z; return a; },
    { x: 0, y: 0, z: 0 });
  c.x /= usar.length; c.y /= usar.length; c.z /= usar.length;

  /* As hélices são desenhadas por um `InstancedMesh` alimentado dentro de
   * `AIManager.update`. Numa captura com o jogo pausado esse update não roda, e
   * a primeira leva de fotos saiu com os drones SEM pá nenhuma. Aqui o lote é
   * preenchido à mão, com a mesma chamada que o manager faz. */
  const rot = ctx.ai.rotores;
  if (rot) {
    rot.comecar();
    for (const d of drones) if (d.corpo.visible) rot.adicionar(d.corpo, d.giroHelice);
    rot.terminar();
  }
  /* PAUSA antes de compor a foto. `window.__game.settle()` renderiza N quadros
   * de forma síncrona, mas o laço de rAF continua rodando entre o fim deste
   * `evaluate` e o `page.screenshot()` — e com o jogo em 'jogando' ele atualiza
   * a IA e a câmera, então a foto sai de um instante diferente do que foi
   * composto. Pausado, o que foi montado é o que é fotografado. */
  ctx.state = 'pausado';
  ctx.camera.up.set(0, 1, 0);
  ctx.camera.position.set(jog.x, jog.y + 1.68, jog.z);
  ctx.camera.lookAt(c.x, c.y, c.z);
  ctx.camera.fov = 75; ctx.camera.updateProjectionMatrix();
  ctx.camera.updateMatrixWorld(true);
  ctx.lighting?.update?.(0, ctx.time.elapsed);
  window.__game.settle(20);
  return {
    n: drones.length, visiveis: visiveis.length,
    dists: drones.map((d) => +d.pos.distanceTo(jog).toFixed(1)).sort((a, b) => a - b),
    alts: drones.map((d) => +(d.pos.y - d._chaoY).toFixed(1)),
    estados: drones.map((d) => d.estado),
  };
});
await page.screenshot({ path: OUT + '/01-enxame-morro.png' });

/* --- 3b. drone de perto: a fenda ciano tem de ler --- */
const perto = await page.evaluate(() => {
  const ctx = window.__game.ctx;
  const ai = ctx.ai;
  ctx.state = 'jogando';
  ai.reset();
  const jog = ctx.player.position;
  const d = ai.spawn({ x: jog.x, y: jog.y, z: jog.z - 3.4 }, 0, [], 'drone');
  if (!d) return { ok: false };
  d.percepcao.avisar(ctx.player.position, 1.4);
  for (let i = 0; i < 120; i++) { ctx.player.update(1 / 60); ai.update(1 / 60); }

  /* Pose de retrato: encara a câmera, na janela de tiro, com o pisca no pico.
   *
   * Escrito à mão em vez de esperar o estado acontecer — a fase do pisca vai a
   * 11 Hz e sortear o instante da foto daria uma fenda apagada metade das
   * vezes. O que se quer julgar aqui é se o ciano LÊ, não se a sorte ajudou. */
  ctx.state = 'pausado';
  d.pos.set(jog.x + 0.10, jog.y + 1.95, jog.z - 3.15);
  d.vel.set(0, 0, 0);
  d.estado = 'pairar';
  d._tPairar = 1.0;
  d._pulso = 1;
  let melhor = -1, melhorT = 0;
  for (let t = 0; t < 0.4; t += 0.0012) {
    d.tEstado = t;
    const v = d.pulsoTelegrafo;
    if (v > melhor) { melhor = v; melhorT = t; }
  }
  d.tEstado = melhorT;
  d.yaw = Math.atan2(jog.x - d.pos.x, jog.z - d.pos.z);
  d.arfagem = -0.14; d.rolagem = 0.10;
  d._pose(0);
  // mesma alimentacao manual do lote de helices (ver a captura do enxame)
  const rot2 = ai.rotores;
  if (rot2) { rot2.comecar(); rot2.adicionar(d.corpo, d.giroHelice); rot2.terminar(); }

  ctx.camera.up.set(0, 1, 0);
  ctx.camera.position.set(jog.x, jog.y + 1.72, jog.z);
  ctx.camera.lookAt(d.pos.x, d.pos.y, d.pos.z);
  ctx.camera.fov = 50; ctx.camera.updateProjectionMatrix();
  ctx.camera.updateMatrixWorld(true);
  ctx.lighting?.update?.(0, ctx.time.elapsed);
  window.__game.settle(24);
  return {
    ok: true, dist: +d.pos.distanceTo(ctx.camera.position).toFixed(2),
    pulso: +d.pulsoTelegrafo.toFixed(2), estado: d.estado,
  };
});
await page.screenshot({ path: OUT + '/02-drone-perto.png' });

/* --- 3c. o drone no mapa do TAB --- */
const tab = await page.evaluate(() => {
  const ctx = window.__game.ctx;
  const ai = ctx.ai;
  ai.reset();
  ctx.camera.fov = 80; ctx.camera.updateProjectionMatrix();
  ctx.state = 'jogando';
  ctx.hud?.setVisible?.(true);

  const jog = ctx.player;
  const yaw = jog.rig?.yaw ?? 0;
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const p = jog.position;

  const V = ctx.camera.position.constructor;
  const col = ctx.world.collision;

  /* PROCURA um ponto DE FATO visível a cada distância, em vez de cravar
   * `frente * d`.
   *
   * A versão anterior punha o drone em `posição + frente*11m` e concluía que o
   * mapa não mostrava drone. Só que o raio até o CENTRO daquele drone também
   * estava bloqueado: o ponto caía dentro de uma casa. Estava medindo "há uma
   * parede na frente do jogador", não "o mapa enxerga drone". Um teste de
   * visibilidade tem de começar por garantir visibilidade. */
  const olho0 = jog.eyePosition.clone();
  const acharVisivel = (distAlvo) => {
    for (let k = 0; k < 120; k++) {
      const ang = (k / 120 - 0.5) * 1.05;          // varre o cone do mapa
      const dx = fx * Math.cos(ang) - fz * Math.sin(ang);
      const dz = fx * Math.sin(ang) + fz * Math.cos(ang);
      const x = p.x + dx * distAlvo, z = p.z + dz * distAlvo;
      const chao = col.groundAt(x, z);
      if (!Number.isFinite(chao)) continue;
      const y = chao + 3.2;                        // altura de cruzeiro do drone
      const dir = new V(x - olho0.x, y - olho0.y, z - olho0.z);
      const c = dir.length();
      if (c < 2) continue;
      dir.divideScalar(c);
      const r = col.raycast(olho0, dir, c - 0.6);
      if (!r || !r.hit) return { x, y, z };
    }
    return null;
  };

  // três drones à frente, em distâncias diferentes, e um ATRÁS (não pode aparecer)
  const feitos = [];
  const semLugar = [];
  for (const dd of [10, 17, 25]) {
    const pt = acharVisivel(dd);
    if (!pt) { semLugar.push(dd); continue; }
    const d = ai.spawn(pt, 0, [], 'drone');
    if (!d) continue;
    d.pos.set(pt.x, pt.y, pt.z);
    d.percepcao.avisar(p, 1.3);
    feitos.push(d);
  }
  const atras = ai.spawn({ x: p.x - fx * 14, y: p.y, z: p.z - fz * 14 }, 0, [], 'drone');
  // poucos quadros: só para a pose assentar, sem deixar o enxame sair do lugar
  for (let i = 0; i < 6; i++) { jog.update(1 / 60); ai.update(1 / 60); }
  for (const d of feitos) d._pose(0);

  const mp = ctx.hud.mapao;
  const vistos = [];
  mp._hostisVisiveis(vistos);

  /* O MAPA DO TAB tem cone HORIZONTAL, sem limite vertical — então o drone
   * voando a 3 m entra. O que pode derrubá-lo é o raycast de visada, que mira
   * em `p.y + 1.1`: para um hostil de chão isso é o peito, para um drone a 3 m
   * de altura é 1,1 m ACIMA dele, e esse metro a mais pode bater num beiral. */
  /* DOIS raios por drone, e a diferença entre eles é a resposta.
   *
   * `MapaGrande._hostisVisiveis` mira em `p.y + 1.1` — o peito de um hostil de
   * chão. Para um drone que voa a 3 m, esse metro e dez a mais aponta para o AR
   * ACIMA dele, e pode bater num beiral que o próprio drone não tem na frente.
   * Medir só esse raio não distingue "o offset atrapalha" de "o drone está
   * mesmo atrás de uma casa". Medindo os dois, a diferença isola o offset. */
  const livre = (alvoY, d) => {
    const olho = jog.eyePosition;
    const dir = { x: d.pos.x - olho.x, y: alvoY - olho.y, z: d.pos.z - olho.z };
    const c = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const r = ctx.world.collision.raycast(olho, new V(dir.x / c, dir.y / c, dir.z / c), c - 0.4);
    return !(r && r.hit);
  };
  const detalhe = feitos.map((d) => {
    const olho = jog.eyePosition;
    return {
      dist: +d.pos.distanceTo(p).toFixed(1),
      alt: +(d.pos.y - d._chaoY).toFixed(1),
      elevacaoGraus: +(Math.atan2(d.pos.y - olho.y, Math.hypot(d.pos.x - olho.x, d.pos.z - olho.z)) * 180 / Math.PI).toFixed(1),
      visadaNoCentro: livre(d.pos.y, d),
      visadaMaisUmMetro: livre(d.pos.y + 1.1, d),
    };
  });

  /* Pausa e abre o TAB. Com o jogo pausado o laço principal ainda chama
   * `hud.update` (ver `main.frame`), então o mapa continua vivo enquanto os
   * drones ficam parados onde foram postos — que é o que a foto precisa. */
  /* CONTINUA EM 'jogando'. Duas tentativas anteriores saíram com o HUD normal
   * em vez do mapão, por dois motivos somados:
   *   1. pausar fecha o mapa (o HUD só o abre em partida — é o que o
   *      `tools/tabmapa.mjs`, que funciona, faz: state 'jogando' o tempo todo);
   *   2. `Input.endFrame()` limpa as teclas a cada quadro, e o laço de rAF roda
   *      entre este `evaluate` e o `page.screenshot()` — adicionar 'Tab' uma
   *      vez abre o mapa e o quadro seguinte o fecha.
   * Neutralizar `endFrame` é o equivalente a manter o dedo na tecla. */
  ctx.input.endFrame = () => {};
  ctx.input.keys.add('Tab');
  for (let i = 0; i < 24; i++) ctx.hud.update(1 / 60);
  return {
    nasceram: feitos.length + (atras ? 1 : 0),
    naFrente: feitos.length, atras: atras ? 1 : 0,
    aparecemNoMapa: vistos.length,
    rodape: document.querySelector('.rodape-mapao .host')?.textContent ?? '',
    detalhe, semLugar,
    vivo: ctx.player.alive,
  };
});
await page.waitForTimeout(400);
await page.screenshot({ path: OUT + '/03-drone-tab.png' });

/* ===================================================================== */

const l = (s) => console.log(s);
l('');
l('MONTAGEM DA ONDA TEMATICA');
l('  onda ' + montagem.onda + ' "' + montagem.rotulo + '"  ·  meta ' + montagem.meta
  + '  ·  simultaneos ' + montagem.simultaneos + '  ·  drones ' + montagem.drones
  + '  ·  teto de atiradores ' + montagem.atiradores + '  ·  nasceram ' + montagem.nasceram);

l('');
l('1) FPS — laco de render de verdade (rAF), 1280x720');
l('              quadros   ms mediana   ms p95   ms max   fps   draw calls   triangulos');
const fl = (t, o) => l('  ' + t.padEnd(12) + String(o.quadros).padStart(6)
  + String(o.msMed).padStart(12) + String(o.msP95).padStart(9) + String(o.msMax).padStart(9)
  + String(o.fpsMed).padStart(7) + String(o.drawCalls).padStart(13)
  + String(o.triangulos).padStart(13));
fl('campo vazio', fpsVazio);
fl('enxame', fpsEnxame);
l('  custo do enxame: ' + (fpsEnxame.msMed - fpsVazio.msMed).toFixed(2) + ' ms/quadro  ·  +'
  + (fpsEnxame.drawCalls - fpsVazio.drawCalls) + ' draw calls  ·  +'
  + (fpsEnxame.triangulos - fpsVazio.triangulos) + ' triangulos');

l('');
l('2) AUDIO — descarte de voz com o enxame em campo (15 s)');
l('  drones em campo: ' + audio.dronesEmCampo + '   ·   cadeia de zumbido montada: ' + (audio.enxameMontado ? 'sim' : 'NAO'));
l('  pedidos de voz ' + audio.pedidos + '  ·  negados ' + audio.negados + '  ·  descarte ' + audio.descartePct + '%');
l('  vozes ativas por segundo: ' + audio.serieVozes.join(','));
l('  pool: ' + audio.pool);
l('  roubos ' + audio.roubos + '  ·  reaproveitados ' + audio.reaproveitados);
l('  TRAVADAS da thread de audio: ' + audio.travadas + '  ·  audio perdido ' + audio.audioPerdidoMs
  + ' ms  ·  maior lacuna ' + audio.maxLacunaMs + ' ms  ·  deriva ' + audio.derivaMs + ' ms');
l('  descarte por prioridade pedida:');
for (const k of Object.keys(audio.porTipo).sort()) {
  const v = audio.porTipo[k];
  l('    ' + k.padEnd(10) + ' pediu ' + String(v.pediu).padStart(5)
    + '  negou ' + String(v.negou).padStart(5)
    + '  (' + Math.round(100 * v.negou / v.pediu) + '%)');
}

l('');
l('3) CAPTURAS  -> shots/drone/');
l('  01-enxame-morro.png   ' + enxameInfo.n + ' drones (' + enxameInfo.visiveis + ' com visada)  dist=[' + (enxameInfo.dists || []).join(',')
  + ']  alt=[' + (enxameInfo.alts || []).join(',') + ']');
l('     estados: ' + JSON.stringify(enxameInfo.estados));
l('  02-drone-perto.png    dist ' + perto.dist + ' m  ·  estado ' + perto.estado + '  ·  pulso ' + perto.pulso);
l('  03-drone-tab.png      ' + tab.naFrente + ' na frente + ' + tab.atras + ' atras;  aparecem no mapa: '
  + tab.aparecemNoMapa + '   rodape="' + tab.rodape.trim() + '"   jogador vivo: ' + tab.vivo);
for (const d of tab.detalhe) {
  l('     drone a ' + d.dist + ' m, alt ' + d.alt + ' m, elevacao ' + d.elevacaoGraus + ' graus');
  l('        visada no CENTRO do drone: ' + (d.visadaNoCentro ? 'livre' : 'BLOQUEADA')
    + '   ·   mirando 1,1 m ACIMA (o que o mapa faz): ' + (d.visadaMaisUmMetro ? 'livre' : 'BLOQUEADA'));
}

await browser.close();
vite.kill();
