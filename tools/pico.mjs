/**
 * pico.mjs — CAPTURA O QUADRO RUIM.
 *
 * Travamento intermitente nao se acha lendo codigo: se acha gravando cada
 * quadro de uma partida de verdade e depois olhando SO a cauda. Esta
 * ferramenta grava, para cada quadro:
 *
 *   dt do rAF (o unico numero que o jogador sente)   ·  programas de shader
 *   compilados ate ali  ·  heap JS  ·  draw calls / triangulos  ·  o tempo de
 *   CADA sistema do laco  ·  os eventos que ocorreram naquele quadro
 *   (tiro, morte, spawn, porta)  ·  onda e censo de hostis.
 *
 * Com isso as tres assinaturas de travada se separam sozinhas:
 *
 *   PERIODICO      picos igualmente espacados. O relatorio testa alinhamento
 *                  com os intervalos declarados no codigo (96 quadros do mapa
 *                  de ambiente, 24 das nuvens, 15 da varredura de materiais).
 *   COMPILACAO     o pico coincide com `renderer.info.programs.length`
 *                  subindo. E o unico caso em que um numero PROVA a causa.
 *   COLETA DE LIXO o pico coincide com o heap CAINDO.
 *
 * Uso:
 *   node tools/pico.mjs                     partida completa, 200 s
 *   MEDIR=90 node tools/pico.mjs            mais curto
 *   AQUECER=0 node tools/pico.mjs           desliga o pre-aquecimento de cena
 *   TAG=antes node tools/pico.mjs           grava tools/pico.<tag>.json
 *
 * ARMADILHAS JA PAGAS (nao repita):
 *  - Medir com o jogo pausado ou com o jogador morto nao mede nada: com
 *    `alvo.alive === false` a IA inteira cai em patrulha (NOTES [AI] secao 5).
 *    Aqui o boneco fica VIVO por blindagem, e o dano continua contabilizado.
 *  - `Player._die()` poe `ctx.state = 'morto'` e o respawn nao desfaz — a
 *    primeira morte congelaria `Progressao` e o resto da corrida rodaria com o
 *    campo vazio.
 *  - Rodar `ai.update()` num laco sincrono dentro de um `page.evaluate`
 *    BLOQUEIA o rAF: nao existe quadro para medir. Todo o trabalho aqui e
 *    feito no laco de rAF de verdade.
 *  - `Input.endFrame()` zera mouse e teclas de pressao a cada quadro. O
 *    piloto automatico escreve no input DEPOIS do quadro do jogo (o callback
 *    de rAF desta ferramenta corre atras do `tick` do jogo), entao o que ele
 *    escreve vale no quadro SEGUINTE.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 5299);
const MEDIR = Number(process.env.MEDIR ?? 200);      // segundos de partida medida
const AQUECER = process.env.AQUECER !== '0';
const TAG = process.env.TAG ?? (AQUECER ? 'depois' : 'antes');
const LARG = Number(process.env.LARG ?? 1280);
const ALT = Number(process.env.ALT ?? 720);

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
  executablePath: process.env.PW_CHROME || undefined,
  args: [
    // GPU de verdade (aqui: GTX 1060 via ANGLE/D3D11). O swiftshader fica so
    // como rede de seguranca: com ele TODO o custo de GPU vira custo de CPU e
    // a atribuicao do pico deixa de valer.
    '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu',
    '--enable-unsafe-swiftshader',
    '--enable-precise-memory-info',            // performance.memory sem quantizacao
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: LARG, height: ALT } });
page.on('pageerror', (e) => console.log('PAGEERR:', String(e).split('\n')[0]));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text().split('\n')[0].slice(0, 160)); });

const url = 'http://127.0.0.1:' + PORT + '/' + (AQUECER ? '' : '?semaquecer=1');
const tBoot0 = Date.now();
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready, undefined, { timeout: 300000 });
const bootMs = Date.now() - tBoot0;
await page.mouse.click(LARG / 2, ALT / 2);
await page.waitForTimeout(1200);

/* ===================================================================== *
 * 1. INSTRUMENTACAO                                                      *
 * ===================================================================== */
const aferi = await page.evaluate(() => {
  const ctx = window.__game.ctx;
  const R = ctx.renderer;
  const gl = R.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');

  /* ---- blindagem do boneco (ver cabecalho) ---- */
  const jog = ctx.player;
  window.__dano = 0;
  if (!jog.__blindado) {
    const orig = jog.takeDamage.bind(jog);
    jog.takeDamage = (d) => { window.__dano += d; return jog.health; };
    jog.__blindado = orig;
  }
  jog.alive = true;
  jog.health = jog.maxHealth;

  /* ---- cronometro por sistema ------------------------------------------
   * Envolve o metodo NA INSTANCIA. O `main.js` guarda referencias aos objetos,
   * nao aos metodos, entao o wrapper entra em vigor sem tocar no laco.
   * ATENCAO: ha aninhamento de proposito (lighting.update contem
   * refreshMaterials e _regenerateEnvironment). O relatorio marca os
   * aninhados com ">" e nao os soma no total. */
  const M = Object.create(null);
  const envolver = (obj, metodo, nome) => {
    if (!obj || typeof obj[metodo] !== 'function') return false;
    const orig = obj[metodo].bind(obj);
    obj[metodo] = function (...a) {
      const t0 = performance.now();
      const r = orig(...a);
      M[nome] = (M[nome] || 0) + (performance.now() - t0);
      return r;
    };
    return true;
  };

  const alvos = [
    [ctx.player, 'update', 'player'], [ctx.ai, 'update', 'ai'],
    [ctx.progressao, 'update', 'progressao'], [ctx.world, 'update', 'world'],
    [ctx.fx, 'update', 'fx'], [ctx.audio, 'update', 'audio'],
    [ctx.pickups, 'update', 'pickups'], [ctx.sky, 'update', 'sky'],
    [ctx.lighting, 'update', 'lighting'], [ctx.postfx, 'update', 'postfx'],
    [ctx.hud, 'update', 'hud'], [ctx.etiquetas, 'update', 'etiquetas'],
    [ctx.musica, 'update', 'musica'], [ctx.engine, 'render', 'render'],
    // suspeitos nomeados (aninhados)
    [ctx.sky, '_renderEnv', '>skyEnv'], [ctx.sky, '_renderClouds', '>skyNuvens'],
    [ctx.lighting, 'refreshMaterials', '>varreMat'],
    [ctx.lighting, '_regenerateEnvironment', '>pmrem'],
    [ctx.lighting, '_updateCascades', '>cascatas'],
    [ctx.ai, 'spawnOnda', '>spawnOnda'],
  ];
  const envolvidos = alvos.filter(([o, m, n]) => envolver(o, m, n)).map(([, , n]) => n);

  /* ---- contadores de evento por quadro ---- */
  const E = { tiro: 0, acerto: 0, morte: 0, dano: 0, ifire: 0, porta: 0, item: 0 };
  const bus = ctx.bus;
  bus.on('weapon:fire', () => E.tiro++);
  bus.on('weapon:hit', () => E.acerto++);
  bus.on('enemy:killed', () => E.morte++);
  bus.on('enemy:damaged', () => E.dano++);
  bus.on('enemy:fire', () => E.ifire++);
  bus.on('player:acao', () => E.porta++);

  /* ---- gravador ---------------------------------------------------------
   * Registrado DEPOIS do jogo: o `tick` do main re-agenda a si mesmo no inicio
   * do proprio callback, entao no quadro seguinte ele corre primeiro e este
   * gravador corre logo atras — vendo o quadro que acabou de acontecer. */
  const Q = [];                 // um registro por quadro
  const novosProgramas = [];    // {quadro, nome, chave}
  const marcos = [];            // {nome, q} — instantes marcados pelo roteiro
  window.__pico = { Q, novosProgramas, marcos, M, E, envolvidos, rodando: false };
  window.__pico.marcar = (nome) => { marcos.push({ nome, q: Q.length }); };

  let ant = performance.now();
  let nProg = R.info.programs ? R.info.programs.length : 0;
  const progVistos = new Set((R.info.programs || []).map((p) => p.cacheKey));
  let iq = 0;

  const passo = () => {
    const t = performance.now();
    const dt = t - ant; ant = t;
    if (window.__pico.rodando) {
      const info = R.info;
      const progs = info.programs || [];
      let dProg = 0;
      if (progs.length !== nProg) {
        for (const p of progs) {
          if (!progVistos.has(p.cacheKey)) {
            progVistos.add(p.cacheKey);
            dProg++;
            if (novosProgramas.length < 400) {
              novosProgramas.push({ q: iq, nome: p.name || '?', chave: String(p.cacheKey).slice(0, 220) });
            }
          }
        }
        nProg = progs.length;
      }
      const ai = ctx.ai;
      let vivos = 0, drones = 0, visiveis = 0;
      for (const e of ai.vivos) {
        if (!e.alive) continue;
        vivos++;
        if (e.eDrone) drones++;
        if (e.eDrone ? e.corpo.visible : e.soldado.grupo.visible) visiveis++;
      }
      Q.push([
        +t.toFixed(2), +dt.toFixed(3), nProg, dProg,
        performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1024) : 0,
        info.render.calls, info.render.triangles,
        vivos, drones, visiveis, ctx.progressao?.onda ?? 0,
        E.tiro, E.acerto, E.morte, E.dano, E.ifire, E.porta,
        ...window.__pico.ordem.map((k) => +(M[k] || 0).toFixed(3)),
      ]);
      iq++;
    }
    for (const k in M) M[k] = 0;
    for (const k in E) E[k] = 0;
    window.__pico.piloto?.();
    requestAnimationFrame(passo);
  };
  window.__pico.ordem = envolvidos;
  requestAnimationFrame(passo);

  return {
    renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    preset: ctx.settings?.q?.name ?? '?',
    largura: ctx.engine.renderWidth, altura: ctx.engine.renderHeight,
    programasNoBoot: (R.info.programs || []).length,
    envolvidos,
    memoriaPrecisa: !!performance.memory,
    aquecimento: window.__aquecimento ?? null,
    sombras: ctx.lighting?.cascades + 'x' + ctx.lighting?.shadowMapSize,
  };
});

/* ===================================================================== *
 * 2. PILOTO AUTOMATICO + PARTIDA DE VERDADE                              *
 * ===================================================================== */
await page.evaluate(() => {
  const ctx = window.__game.ctx;
  const inp = ctx.input;
  const jog = ctx.player;
  inp.locked = true;                 // finge pointer lock: o Player le o teclado
  ctx.settings.set?.('musicVolume', 0.35);

  const V = ctx.camera.position.constructor;
  const dirTmp = new V();
  let t = 0, fase = 0;

  /* Piloto: anda, gira PARA os hostis (e a condicao do relato — "a tela enche
   * de player"), atira em rajadas, recarrega, agacha e corre. Nao e um humano;
   * e uma carga repetivel que produz os mesmos eventos que um humano produz. */
  window.__pico.piloto = () => {
    t += 1 / 60;
    fase += 1 / 60;
    const ws = jog.weapons;
    if (ws && ws.reserve < 30) ws.slots[ws.index].reserve = 300;   // municao infinita: a carga nao pode parar
    if (ws && ws.ammo === 0 && !ws.reloading) inp._pressedThisFrame.add('KeyR');

    // --- olhar: mira no hostil mais proximo com visada ---
    let alvo = null, melhor = 1e9;
    for (const e of ctx.ai.vivos) {
      if (!e.alive) continue;
      const d = e.pos.distanceToSquared(jog.position);
      if (d < melhor) { melhor = d; alvo = e; }
    }
    const rig = jog.rig;
    const sens = ctx.settings?.sensitivity ?? 0.0022;
    if (alvo && rig) {
      /* Mira em DOIS eixos. So o yaw nao serve: o drone voa a 2,4-4,2 m do
       * chao e o hostil de chao pode estar num nivel acima — sem pitch o
       * boneco atira no muro e a carga de combate nunca acontece. */
      dirTmp.subVectors(alvo.eDrone ? alvo.pos : alvo.pos, jog.eyePosition);
      if (!alvo.eDrone) dirTmp.y += 1.1;            // peito, nao os pes
      const yawAlvo = Math.atan2(-dirTmp.x, -dirTmp.z);
      const pitchAlvo = Math.atan2(dirTmp.y, Math.hypot(dirTmp.x, dirTmp.z));
      let d = yawAlvo - rig.yaw;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      const dp = pitchAlvo - rig.pitch;
      const passoMax = 0.075;                       // rad/quadro: mira humana
      const giro = Math.max(-passoMax, Math.min(passoMax, d * 0.22));
      const sobe = Math.max(-passoMax, Math.min(passoMax, dp * 0.22));
      inp.mouseDX = -giro / sens;
      inp.mouseDY = -sobe / sens;
      const perto = Math.hypot(d, dp) < 0.10;
      inp.buttons[0] = perto && Math.sqrt(melhor) < 55 && !!ws && ws.ammo > 0;
      inp.buttons[2] = Math.hypot(d, dp) < 0.25 && Math.sqrt(melhor) > 18;   // mira quando longe
    } else {
      inp.mouseDX = 0.9 / sens * (Math.sin(t * 0.31) > 0 ? 1 : -1) * 0.02;
      inp.buttons[0] = false;
      inp.buttons[2] = false;
    }

    // --- pernas: ciclo de 8 s (andar, correr, agachar, pular, strafe) ---
    const c = fase % 8;
    inp.keys.delete('KeyA'); inp.keys.delete('KeyD');
    inp.keys.delete('ShiftLeft'); inp.keys.delete('KeyC');
    inp.keys.add('KeyW');
    if (c < 2.5) inp.keys.add('ShiftLeft');
    else if (c < 4) inp.keys.add('KeyA');
    else if (c < 5.5) inp.keys.add('KeyD');
    else if (c < 6.5) inp.keys.add('KeyC');
    if (Math.abs(c - 7.0) < 1 / 60) inp._pressedThisFrame.add('Space');
    if (Math.abs(c - 3.0) < 1 / 60) inp._pressedThisFrame.add('KeyF');   // porta
    if (Math.abs(c - 5.0) < 1 / 60) inp._pressedThisFrame.add('KeyQ');   // troca de arma
  };
});

/* ===================================================================== *
 * 3. ROTEIRO — a pergunta e "PRIMEIRA VEZ ou TODA VEZ?"                  *
 * ===================================================================== *
 * A gravacao comeca com o campo VAZIO, de proposito: sem isso o primeiro
 * quadro medido ja e o quadro da entrada dos hostis e nao ha linha de base.
 * Depois cada familia de inimigo entra DUAS vezes, com o campo limpo entre
 * uma e outra. Se o pico so aparece na primeira entrada, e compilacao de
 * shader; se aparece nas duas, e trabalho de spawn.                       */
await page.evaluate(() => {
  window.__pico.rodando = true;
  window.__pico.marcar('gravacao-comeca');
});
await page.waitForTimeout(4000);   // linha de base com o campo vazio

const roteiro = [
  ['1a-onda-chao', 45, () => {
    const ctx = window.__game.ctx;
    ctx.menu?.hideAll?.();
    ctx.state = 'jogando';
    ctx.bus.emit('game:start', {});
    ctx.ai.spawnAutomatico = true;
  }],
  ['2a-leva-chao', 25, () => {
    const ctx = window.__game.ctx;
    // A partir daqui quem povoa o campo e o roteiro, nao a Progressao.
    if (ctx.progressao) ctx.progressao.fase = 'fim';
    ctx.ai.reset();
    ctx.ai.spawnAutomatico = false;
    ctx.ai.maxVivos = 10;
    ctx.ai.spawnOnda(8, 12, 40, 'solo');
    ctx.ai.convergirNoJogador(1.2);
  }],
  ['1o-enxame-drone', 35, () => {
    const ctx = window.__game.ctx;
    ctx.ai.reset();
    ctx.ai.maxDrones = 8;
    ctx.ai.maxVivos = 10;
    ctx.ai.maxAtiradores = 3;
    ctx.ai.spawnOnda(8, 14, 40, 'drone');
    ctx.ai.convergirNoJogador(1.2);
  }],
  ['2o-enxame-drone', 30, () => {
    const ctx = window.__game.ctx;
    ctx.ai.reset();
    ctx.ai.spawnOnda(8, 14, 40, 'drone');
    ctx.ai.convergirNoJogador(1.2);
  }],
  ['chao+drone-juntos', 40, () => {
    const ctx = window.__game.ctx;
    ctx.ai.reset();
    ctx.ai.maxVivos = 16;
    ctx.ai.spawnOnda(8, 12, 40, 'solo');
    ctx.ai.spawnOnda(6, 14, 40, 'drone');
    ctx.ai.convergirNoJogador(1.2);
  }],
];

const escala = MEDIR / roteiro.reduce((a, r) => a + r[1], 0);
process.stdout.write(`medindo (aquecimento=${AQUECER ? 'ligado' : 'DESLIGADO'})`);
for (const [nome, seg, fn] of roteiro) {
  await page.evaluate(({ nome, corpo }) => {
    window.__pico.marcar(nome);
    // eslint-disable-next-line no-new-func
    (new Function('return (' + corpo + ')'))()();
  }, { nome, corpo: fn.toString() });
  const ms = Math.max(6000, Math.round(seg * escala * 1000));
  for (let s = 0; s < ms; s += 5000) {
    await page.waitForTimeout(Math.min(5000, ms - s));
    process.stdout.write('.');
  }
}
console.log('');

const bruto = await page.evaluate(() => {
  window.__pico.rodando = false;
  const ctx = window.__game.ctx;
  return {
    Q: window.__pico.Q, ordem: window.__pico.ordem,
    novosProgramas: window.__pico.novosProgramas,
    marcos: window.__pico.marcos,
    onda: ctx.progressao?.onda, abates: ctx.progressao?.abates ?? null,
    dano: window.__dano,
    programasFim: (ctx.renderer.info.programs || []).length,
  };
});

await browser.close();
vite.kill();

/* ===================================================================== *
 * 3. ANALISE                                                            *
 * ===================================================================== */
const Q = bruto.Q;
const ordem = bruto.ordem;
const BASE = 17;                       // colunas fixas antes dos tempos por sistema
const col = { t: 0, dt: 1, prog: 2, dprog: 3, heap: 4, calls: 5, tris: 6, vivos: 7, drones: 8, vis: 9, onda: 10, tiro: 11, acerto: 12, morte: 13, dmg: 14, ifire: 15, porta: 16 };
const sis = (q, nome) => q[BASE + ordem.indexOf(nome)];

if (Q.length < 100) {
  console.log('MEDICAO INVALIDA: so ' + Q.length + ' quadros gravados.');
  process.exit(1);
}

const dts = Q.map((q) => q[col.dt]).sort((a, b) => a - b);
const pct = (p) => dts[Math.min(dts.length - 1, Math.floor(dts.length * p))];
const p50 = pct(0.50), p90 = pct(0.90), p99 = pct(0.99), p999 = pct(0.999), pmax = dts[dts.length - 1];
const dur = (Q[Q.length - 1][col.t] - Q[0][col.t]) / 1000;

const l = (s = '') => console.log(s);
const n2 = (x) => (x == null ? '-' : x.toFixed(2));

l('');
l('=========================================================================');
l('AFERICAO DO INSTRUMENTO');
l('=========================================================================');
l('  GPU            ' + aferi.renderer);
l('  preset         ' + aferi.preset + '   render ' + aferi.largura + 'x' + aferi.altura
  + '   sombras ' + aferi.sombras);
l('  boot           ' + (bootMs / 1000).toFixed(1) + ' s   ·  programas ao fim do boot: ' + aferi.programasNoBoot);
l('  pre-aquecimento de cena: ' + (AQUECER ? 'LIGADO' : 'desligado (?semaquecer=1)')
  + (aferi.aquecimento ? '  ->  ' + JSON.stringify(aferi.aquecimento) : ''));
l('  heap preciso   ' + (aferi.memoriaPrecisa ? 'sim' : 'NAO (performance.memory ausente)'));
l('  partida        ' + dur.toFixed(0) + ' s  ·  ' + Q.length + ' quadros  ·  onda alcancada '
  + bruto.onda + '  ·  dano tomado ' + Math.round(bruto.dano));

l('');
l('=========================================================================');
l('TEMPO DE QUADRO — a cauda, que e o que trava');
l('=========================================================================');
l('  p50 ' + n2(p50) + ' ms (' + (1000 / p50).toFixed(0) + ' fps)   p90 ' + n2(p90)
  + '   p99 ' + n2(p99) + '   p99.9 ' + n2(p999) + '   PIOR ' + n2(pmax) + ' ms');

// histograma
const faixas = [0, 8, 12, 16, 20, 25, 33, 50, 80, 120, 200, 400, 1e9];
const hist = new Array(faixas.length - 1).fill(0);
for (const q of Q) {
  const d = q[col.dt];
  for (let i = 0; i < hist.length; i++) if (d >= faixas[i] && d < faixas[i + 1]) { hist[i]++; break; }
}
l('');
l('  histograma (quadros por faixa de ms)');
const maxH = Math.max(...hist);
for (let i = 0; i < hist.length; i++) {
  if (!hist[i]) continue;
  const rot = (faixas[i + 1] > 1e8 ? '>' + faixas[i] : faixas[i] + '-' + faixas[i + 1]).padStart(9);
  const barra = '#'.repeat(Math.max(1, Math.round(40 * hist[i] / maxH)));
  l('   ' + rot + ' ms  ' + String(hist[i]).padStart(6) + '  ' + barra);
}

/* --- picos --- */
const LIMIAR = Math.max(2.5 * p50, 28);
const picos = [];
for (let i = 0; i < Q.length; i++) if (Q[i][col.dt] >= LIMIAR) picos.push(i);

l('');
l('=========================================================================');
l('PICOS  (limiar ' + LIMIAR.toFixed(1) + ' ms = max(2,5 x p50, 28 ms))');
l('=========================================================================');
l('  ' + picos.length + ' picos em ' + Q.length + ' quadros  ('
  + (100 * picos.length / Q.length).toFixed(2) + '%)  ·  '
  + (picos.length / dur).toFixed(2) + ' por segundo');

/* Assinatura 1: PERIODICO? Intervalos entre picos consecutivos. */
if (picos.length > 3) {
  const gaps = [];
  for (let i = 1; i < picos.length; i++) gaps.push(picos[i] - picos[i - 1]);
  const conta = new Map();
  for (const g of gaps) conta.set(g, (conta.get(g) || 0) + 1);
  const top = [...conta.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const gs = [...gaps].sort((a, b) => a - b);
  l('');
  l('  ASSINATURA PERIODICA — intervalo entre picos (em quadros)');
  l('    mediana ' + gs[gs.length >> 1] + '   min ' + gs[0] + '   max ' + gs[gs.length - 1]);
  l('    intervalos mais frequentes: ' + top.map(([g, c]) => g + 'x' + c).join('  '));
  // alinhamento com os intervalos declarados no codigo
  for (const [nome, per] of [['mapa de ambiente (Sky._envInterval)', 96], ['nuvens', 24], ['varredura de materiais', 15]]) {
    const resto = new Map();
    for (const i of picos) { const r = i % per; resto.set(r, (resto.get(r) || 0) + 1); }
    const maior = Math.max(...resto.values());
    const esperado = picos.length / per;
    l('    alinhamento com ' + nome.padEnd(38) + ' periodo ' + String(per).padStart(3)
      + ': maior classe ' + maior + ' de ' + picos.length
      + ' (acaso ~' + esperado.toFixed(1) + ')');
  }
}

/* Assinatura 2: COMPILACAO. */
const picosComProg = picos.filter((i) => Q[i][col.dprog] > 0);
const progNaPartida = Q.reduce((a, q) => a + q[col.dprog], 0);
l('');
l('  ASSINATURA DE COMPILACAO DE SHADER');
l('    programas novos durante a partida: ' + progNaPartida
  + '  (boot terminou com ' + aferi.programasNoBoot + ', partida terminou com ' + bruto.programasFim + ')');
l('    picos que coincidem com programa novo: ' + picosComProg.length + ' de ' + picos.length);
{
  const comProg = Q.filter((q) => q[col.dprog] > 0).map((q) => q[col.dt]).sort((a, b) => b - a);
  if (comProg.length) {
    l('    quadros COM programa novo: ' + comProg.length + '  ·  pior ' + n2(comProg[0])
      + ' ms  ·  mediana ' + n2(comProg[comProg.length >> 1]) + ' ms');
    const custo = Q.filter((q) => q[col.dprog] > 0).reduce((a, q) => a + q[col.dt] - p50, 0);
    l('    tempo TOTAL perdido nesses quadros (acima do p50): ' + custo.toFixed(0) + ' ms');
  }
}

/* Assinatura 3: COLETA DE LIXO. */
{
  let quedas = 0, maiorQueda = 0, picosComQueda = 0;
  for (let i = 1; i < Q.length; i++) {
    const d = Q[i][col.heap] - Q[i - 1][col.heap];
    if (d < -2000) { quedas++; if (-d > maiorQueda) maiorQueda = -d; }
  }
  for (const i of picos) {
    if (i > 0 && Q[i][col.heap] - Q[i - 1][col.heap] < -2000) picosComQueda++;
  }
  const h0 = Q[0][col.heap], h1 = Q[Q.length - 1][col.heap];
  l('');
  l('  ASSINATURA DE COLETA DE LIXO (heap JS)');
  l('    heap ' + (h0 / 1024).toFixed(1) + ' -> ' + (h1 / 1024).toFixed(1) + ' MB'
    + '   ·  quedas > 2 MB: ' + quedas + '  (maior ' + (maiorQueda / 1024).toFixed(1) + ' MB)');
  l('    picos coincidentes com queda de heap: ' + picosComQueda + ' de ' + picos.length);
  // taxa de alocacao: subida media por quadro
  let subida = 0, nsub = 0;
  for (let i = 1; i < Q.length; i++) {
    const d = Q[i][col.heap] - Q[i - 1][col.heap];
    if (d > 0) { subida += d; nsub++; }
  }
  l('    alocacao media: ' + (subida / Q.length).toFixed(0) + ' KB por quadro');
}

/* --- os 20 piores quadros, com tudo --- */
const piores = [...Q.keys()].sort((a, b) => Q[b][col.dt] - Q[a][col.dt]).slice(0, 20);
l('');
l('=========================================================================');
l('OS 20 PIORES QUADROS');
l('=========================================================================');
l('     t(s)     ms   dProg  dHeapKB  onda vivos/dro/vis  eventos          sistemas dominantes');
for (const i of piores) {
  const q = Q[i];
  const dHeap = i > 0 ? q[col.heap] - Q[i - 1][col.heap] : 0;
  const ev = [];
  if (q[col.tiro]) ev.push('tiro' + q[col.tiro]);
  if (q[col.morte]) ev.push('morte' + q[col.morte]);
  if (q[col.dmg]) ev.push('dano' + q[col.dmg]);
  if (q[col.ifire]) ev.push('iafogo' + q[col.ifire]);
  if (q[col.porta]) ev.push('acao');
  const tempos = ordem.map((k, j) => [k, q[BASE + j]]).filter(([k, v]) => v > 0.4 && !k.startsWith('>'))
    .sort((a, b) => b[1] - a[1]).slice(0, 4);
  const aninh = ordem.map((k, j) => [k, q[BASE + j]]).filter(([k, v]) => v > 0.4 && k.startsWith('>'))
    .sort((a, b) => b[1] - a[1]).slice(0, 3);
  l('  ' + ((q[col.t] - Q[0][col.t]) / 1000).toFixed(1).padStart(7)
    + n2(q[col.dt]).padStart(8)
    + String(q[col.dprog]).padStart(7)
    + String(dHeap).padStart(9)
    + String(q[col.onda]).padStart(6)
    + (q[col.vivos] + '/' + q[col.drones] + '/' + q[col.vis]).padStart(9) + '  '
    + ev.join(',').padEnd(16) + ' '
    + tempos.map(([k, v]) => k + ' ' + v.toFixed(1)).join(' · ')
    + (aninh.length ? '   [' + aninh.map(([k, v]) => k.slice(1) + ' ' + v.toFixed(1)).join(' ') + ']' : ''));
}

/* --- primeira vez x toda vez: por trecho do roteiro --- */
l('');
l('=========================================================================');
l('PRIMEIRA VEZ x TODA VEZ  —  cada trecho do roteiro');
l('=========================================================================');
l('  Se o pico so aparece na PRIMEIRA entrada de cada familia de inimigo, e');
l('  compilacao de shader. Se repete na segunda, e trabalho de spawn.');
l('');
l('  trecho                 quadros    p50     p99    PIOR   progNovos   pior nos 2 s seguintes');
const marcos = bruto.marcos || [];
for (let i = 0; i < marcos.length; i++) {
  const a = marcos[i].q, b = i + 1 < marcos.length ? marcos[i + 1].q : Q.length;
  const sub = Q.slice(a, b);
  if (sub.length < 10) continue;
  const d = sub.map((q) => q[col.dt]).sort((x, y) => x - y);
  const pr = sub.reduce((s, q) => s + q[col.dprog], 0);
  const dep = Q.slice(a, Math.min(b, a + 120)).map((q) => q[col.dt]).sort((x, y) => x - y);
  l('  ' + marcos[i].nome.padEnd(22) + String(sub.length).padStart(7)
    + n2(d[d.length >> 1]).padStart(8) + n2(d[Math.floor(d.length * 0.99)]).padStart(8)
    + n2(d[d.length - 1]).padStart(8) + String(pr).padStart(12)
    + n2(dep[dep.length - 1]).padStart(12) + ' ms');
}

/* --- quem compilou o que --- */
if (bruto.novosProgramas.length) {
  l('');
  l('=========================================================================');
  l('PROGRAMAS COMPILADOS DURANTE A PARTIDA (quadro · material · chave)');
  l('=========================================================================');
  for (const p of bruto.novosProgramas.slice(0, 60)) {
    const q = Q[p.q];
    l('  q' + String(p.q).padStart(6) + '  ' + (q ? n2(q[col.dt]).padStart(7) + ' ms' : '        ')
      + '  ' + String(p.nome).slice(0, 28).padEnd(30) + p.chave.slice(0, 70));
  }
  if (bruto.novosProgramas.length > 60) l('  ... e mais ' + (bruto.novosProgramas.length - 60));
}

/* --- custo medio por sistema (para saber onde o quadro NORMAL mora) --- */
l('');
l('=========================================================================');
l('CUSTO POR SISTEMA — mediana e p99 (ms/quadro).  ">" = aninhado, nao soma');
l('=========================================================================');
const linhas = ordem.map((k, j) => {
  const v = Q.map((q) => q[BASE + j]).sort((a, b) => a - b);
  return [k, v[v.length >> 1], v[Math.floor(v.length * 0.99)], v[v.length - 1]];
}).sort((a, b) => b[1] - a[1]);
for (const [k, m, p, mx] of linhas) {
  if (m < 0.005 && p < 0.05 && mx < 1) continue;
  l('  ' + k.padEnd(14) + n2(m).padStart(8) + n2(p).padStart(9) + n2(mx).padStart(10));
}

mkdirSync(ROOT + '/tools', { recursive: true });
writeFileSync(ROOT + '/tools/pico.' + TAG + '.json', JSON.stringify({
  aferi, MEDIR, AQUECER, dur, quadros: Q.length,
  p50, p90, p99, p999, pmax, picos: picos.length, LIMIAR,
  progNaPartida, programasNoBoot: aferi.programasNoBoot, programasFim: bruto.programasFim,
  ordem, piores: piores.map((i) => Q[i]), novosProgramas: bruto.novosProgramas,
  marcos: bruto.marcos,
  trechos: (bruto.marcos || []).map((m, i, arr) => {
    const a = m.q, b = i + 1 < arr.length ? arr[i + 1].q : Q.length;
    const sub = Q.slice(a, b);
    if (sub.length < 10) return null;
    const d = sub.map((q) => q[col.dt]).sort((x, y) => x - y);
    return {
      nome: m.nome, quadros: sub.length,
      p50: d[d.length >> 1], p99: d[Math.floor(d.length * 0.99)], pior: d[d.length - 1],
      progNovos: sub.reduce((s, q) => s + q[col.dprog], 0),
    };
  }).filter(Boolean),
}, null, 1));
l('');
l('gravado: tools/pico.' + TAG + '.json');
