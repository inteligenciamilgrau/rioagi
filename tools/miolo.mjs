/**
 * miolo.mjs — O QUE HA DENTRO DO `ai.update`.
 *
 * O `pico.mjs` responde "qual sistema comeu o quadro". Quando a resposta e
 * `ai.update`, ele acaba. Esta ferramenta comeca ai: quebra o `ai.update` por
 * SUB-SISTEMA (percepcao, decisao, navegacao, voo, desvio, animacao, ragdoll,
 * zumbido) com tempo EXCLUSIVO (descontado o que os filhos gastaram), e conta
 * quantos RAIOS cada sub-sistema atirou naquele quadro.
 *
 * Por que raio contado por fase, e nao so tempo: raio contra BVH satura CPU sem
 * tocar a GPU, que e exatamente o sintoma relatado. E o `AIManager` mantem um
 * orcamento de raios (`FICHAS_LOS`) que so cobre a linha de visada da
 * percepcao — o resto (sonda de chao, desvio do drone, depenetracao, busca de
 * cobertura) atira a vontade. Sem contar por fase nao da para provar isso.
 *
 * Cada quadro grava:
 *   dt do rAF · ai.update total · ms exclusivo de cada fase da IA · raios por
 *   fase (raycast / sphereCast / capsuleSweep separados) · ms gasto DENTRO da
 *   colisao por fase · buscas de A*, nos expandidos, falhas e acertos de cache
 *   · heap · censo de vivos/drones/atirando · programas de shader.
 *
 * Uso:
 *   node tools/miolo.mjs                  roteiro completo (~5 min medidos)
 *   MEDIR=120 node tools/miolo.mjs        mais curto
 *   TAG=antes node tools/miolo.mjs        grava tools/miolo.<tag>.json
 *   CENA=misto node tools/miolo.mjs       so um trecho (chao|enxame|misto|stress)
 *
 * ARMADILHAS JA PAGAS (herdadas do reacao/pico/enxame — nao repita):
 *  - Jogador MORTO envenena tudo: com `alvo.alive === false` a IA inteira cai
 *    em patrulha e a medicao vira silencio. O boneco aqui e blindado.
 *  - `Player._die()` poe `ctx.state = 'morto'` e o respawn nao desfaz.
 *  - Laco sincrono dentro de `page.evaluate` BLOQUEIA o rAF: nao existe quadro
 *    para medir. Tudo aqui roda no laco de verdade.
 *  - `ctx.player.eyePosition` so e escrito por `Player.update()`.
 *  - Bancada ruidosa: a coluna `fora` (dt que nao esta em nenhum sistema)
 *    separa "o jogo engasgou" de "a maquina engasgou".
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 5311);
const MEDIR = Number(process.env.MEDIR ?? 300);
const TAG = process.env.TAG ?? 'depois';
const CENA = process.env.CENA ?? '';
const LARG = Number(process.env.LARG ?? 1280);
const ALT = Number(process.env.ALT ?? 720);

const vite = spawn(process.execPath, [
  ROOT + '/node_modules/vite/bin/vite.js',
  '--config', 'tools/vite.hires.config.js',
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
    '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu',
    '--enable-unsafe-swiftshader',
    '--enable-precise-memory-info',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: LARG, height: ALT } });
page.on('pageerror', (e) => console.log('PAGEERR:', String(e).split('\n')[0]));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text().split('\n')[0].slice(0, 160)); });

const tBoot0 = Date.now();
await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load', timeout: 120000 });
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

  /* --- blindagem do boneco --- */
  const jog = ctx.player;
  window.__dano = 0;
  if (!jog.__blindado) {
    const orig = jog.takeDamage.bind(jog);
    jog.takeDamage = (d) => { window.__dano += d; return jog.health; };
    jog.__blindado = orig;
  }
  jog.alive = true;
  jog.health = jog.maxHealth;

  /* ------------------------------------------------------------------ *
   * Cronometro com PILHA: tempo EXCLUSIVO por fase.
   *
   * Sem descontar o filho, `ai` mediria 100% e todo o resto seria ruido.
   * A pilha e de arrays paralelos e NAO aloca — se alocasse, a propria
   * medicao de alocacao (que e uma das perguntas) estaria contaminada.
   * ------------------------------------------------------------------ */
  const MS = Object.create(null);      // exclusivo
  const MSTOT = Object.create(null);   // inclusivo
  const CHAM = Object.create(null);    // chamadas
  const RC = Object.create(null);      // raycast por fase
  const SC = Object.create(null);      // sphereCast por fase
  const CS = Object.create(null);      // capsuleSweep por fase
  const MSCOL = Object.create(null);   // ms dentro da colisao, por fase

  const PN = new Array(64);            // pilha: nome
  const PF = new Float64Array(64);     // pilha: ms ja gasto por filhos
  let sp = 0;
  let fase = 'fora';

  const envolver = (obj, metodo, nome) => {
    if (!obj || typeof obj[metodo] !== 'function') return null;
    if (obj[`__env_${metodo}`]) return nome;
    const orig = obj[metodo];
    obj[`__env_${metodo}`] = true;
    obj[metodo] = function (...a) {
      const t0 = performance.now();
      const meu = sp;
      PN[sp] = nome; PF[sp] = 0; sp++;
      fase = nome;
      try {
        return orig.apply(this, a);
      } finally {
        const dt = performance.now() - t0;
        sp = meu;
        MS[nome] = (MS[nome] || 0) + (dt - PF[meu]);
        MSTOT[nome] = (MSTOT[nome] || 0) + dt;
        CHAM[nome] = (CHAM[nome] || 0) + 1;
        if (sp > 0) PF[sp - 1] += dt;
        fase = sp > 0 ? PN[sp - 1] : 'fora';
      }
    };
    return nome;
  };

  /* --- contador de raios, cobrado na fase corrente --- */
  const col = ctx.world?.collision;
  const contar = (metodo, tabela) => {
    if (!col || typeof col[metodo] !== 'function') return;
    const orig = col[metodo].bind(col);
    col[metodo] = (...a) => {
      const t0 = performance.now();
      const r = orig(...a);
      const dt = performance.now() - t0;
      tabela[fase] = (tabela[fase] || 0) + 1;
      MSCOL[fase] = (MSCOL[fase] || 0) + dt;
      return r;
    };
  };
  contar('raycast', RC);
  contar('sphereCast', SC);
  contar('capsuleSweep', CS);

  /* --- fases da IA (prototipos: pega todas as instancias do pool) --- */
  const ai = ctx.ai;
  const umSolo = ai.poolSolo?.[0];
  const umDrone = ai.poolDrone?.[0];
  const P = (o) => (o ? Object.getPrototypeOf(o) : null);
  const protoEnemy = P(umSolo), protoDrone = P(umDrone);
  const protoPerc = P(umSolo?.percepcao), protoSold = P(umSolo?.soldado);
  const protoNav = P(ai.nav), protoRot = P(ai.rotores), protoAI = P(ai);

  const fases = [];
  const add = (o, m, n) => { const r = envolver(o, m, n); if (r) fases.push(r); };

  add(protoAI, 'update', 'ai');
  add(protoAI, '_zumbir', 'zumbido');
  add(protoAI, 'spawnOnda', 'spawn');
  add(protoNav, 'update', 'nav');
  add(protoNav, 'buscar', 'nav.buscar');
  add(protoNav, '_astar', 'nav.astar');
  add(protoNav, '_suavizar', 'nav.suaviza');
  add(protoPerc, 'update', 'percepcao');
  add(protoEnemy, '_pensar', 'solo.pensar');
  add(protoEnemy, '_acharCobertura', 'solo.cobertura');
  add(protoEnemy, '_vigiar', 'solo.vigiar');
  add(protoEnemy, '_mover', 'solo.mover');
  add(protoEnemy, '_apontar', 'solo.apontar');
  add(protoSold, 'update', 'solo.anim');
  add(protoDrone, '_pensar', 'drone.pensar');
  add(protoDrone, '_mover', 'drone.voo');
  add(protoDrone, '_apontar', 'drone.apontar');
  add(protoDrone, '_pose', 'drone.pose');
  add(protoDrone, '_cair', 'drone.cair');
  add(protoEnemy, '_atirar', 'solo.tiro');
  add(protoEnemy, '_abrirFogo', 'solo.abrirFogo');
  add(protoDrone, '_atirar', 'drone.tiro');
  add(protoAI, 'vagaDeFogo', 'vagaDeFogo');
  add(protoAI, '_ouviram', 'audicao');
  /* Audio: o zumbido do enxame e a hipotese explicita do jogador. Ele entra
   * aqui como fase propria, aninhada dentro de `zumbido`, para o custo dele
   * sair com numero e nao com opiniao. */
  for (const m of ['zumbidoEnxame', 'tiro', 'grito', 'impacto', 'droneInvestida', 'droneQueda', 'recarga'])
    add(ctx.audio, m, 'aud.' + m);
  add(ctx.bus, 'emit', 'bus.emit');
  add(protoRot, 'adicionar', 'rotores');
  // sistemas vizinhos, para a conta de quadro fechar
  add(ctx.player, 'update', 'player');
  add(ctx.fx, 'update', 'fx');
  add(ctx.audio, 'update', 'audio');
  add(ctx.engine, 'render', 'render');

  /* Ragdoll nasce so na primeira morte: o prototipo e capturado depois. */
  window.__miolo = { ragdollPronto: false };

  /* --- gravador --------------------------------------------------------
   * Registrado DEPOIS do jogo: o `tick` do main se re-agenda no inicio do
   * proprio callback, entao no quadro seguinte ele corre primeiro e este
   * gravador corre logo atras, vendo o quadro que acabou de acontecer. */
  const Q = [];
  const marcos = [];
  const nav = ai.nav;
  let ant = performance.now();
  let navAnt = { buscas: 0, nos: 0, cacheHit: 0, falhas: 0 };
  let nProg = R.info.programs ? R.info.programs.length : 0;

  const ORDEM = fases.slice();
  const M = window.__miolo;
  M.Q = Q; M.marcos = marcos; M.ordem = ORDEM; M.rodando = false;
  M.marcar = (nome) => marcos.push({ nome, q: Q.length });

  const passo = () => {
    const t = performance.now();
    const dt = t - ant; ant = t;

    if (!M.ragdollPronto) {
      for (const e of ai.vivos) {
        if (e.ragdoll) {
          envolver(Object.getPrototypeOf(e.ragdoll), 'update', 'ragdoll');
          if (!ORDEM.includes('ragdoll')) ORDEM.push('ragdoll');
          M.ragdollPronto = true;
          break;
        }
      }
    }

    if (M.rodando) {
      const s = nav?.stats ?? navAnt;
      const dBusca = s.buscas - navAnt.buscas;
      const dNos = s.nos - navAnt.nos;
      const dHit = s.cacheHit - navAnt.cacheHit;
      const dFalha = s.falhas - navAnt.falhas;
      navAnt = { buscas: s.buscas, nos: s.nos, cacheHit: s.cacheHit, falhas: s.falhas };

      let vivos = 0, drones = 0, atirando = 0, ragd = 0, longe = 0;
      const jogP = ctx.player?.position;
      for (const e of ai.vivos) {
        if (e.morto) { if (e.ragdoll) ragd++; continue; }
        if (!e.alive) continue;
        vivos++;
        if (e.eDrone) drones++;
        if (e.ocupaVagaDeFogo) atirando++;
        if (jogP && e.pos.distanceTo(jogP) > 38) longe++;
      }
      const progs = R.info.programs || [];
      if (progs.length !== nProg) nProg = progs.length;

      let rc = 0, sc = 0, cs = 0;
      for (const k in RC) rc += RC[k];
      for (const k in SC) sc += SC[k];
      for (const k in CS) cs += CS[k];

      Q.push([
        +t.toFixed(2), +dt.toFixed(3), +(MSTOT['ai'] || 0).toFixed(3),
        performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1024) : 0,
        vivos, drones, atirando, ragd, longe, nProg,
        dBusca, dNos, dHit, dFalha,
        rc, sc, cs,
        ...ORDEM.map((k) => +(MS[k] || 0).toFixed(3)),
        ...ORDEM.map((k) => (RC[k] || 0) + (SC[k] || 0) + (CS[k] || 0)),
        ...ORDEM.map((k) => +(MSCOL[k] || 0).toFixed(3)),
      ]);
    }
    for (const k in MS) MS[k] = 0;
    for (const k in MSTOT) MSTOT[k] = 0;
    for (const k in CHAM) CHAM[k] = 0;
    for (const k in RC) RC[k] = 0;
    for (const k in SC) SC[k] = 0;
    for (const k in CS) CS[k] = 0;
    for (const k in MSCOL) MSCOL[k] = 0;
    M.piloto?.();
    requestAnimationFrame(passo);
  };
  requestAnimationFrame(passo);

  return {
    renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    preset: ctx.settings?.q?.name ?? '?',
    largura: ctx.engine.renderWidth, altura: ctx.engine.renderHeight,
    fases: ORDEM.slice(),
    poolSolo: ai.poolSolo?.length ?? 0, poolDrone: ai.poolDrone?.length ?? 0,
    fichas: 6,
    memoriaPrecisa: !!performance.memory,
    isolado: !!self.crossOriginIsolated,
    resolucaoRelogio: (() => {
      // menor diferenca nao nula entre duas leituras seguidas = granularidade real
      let m = Infinity;
      for (let i = 0; i < 200000; i++) {
        const a = performance.now(), b = performance.now();
        const d = b - a;
        if (d > 0 && d < m) m = d;
      }
      return m;
    })(),
  };
});

/* ===================================================================== *
 * 2. PILOTO — combate de verdade, repetivel                              *
 * ===================================================================== */
await page.evaluate(() => {
  const ctx = window.__game.ctx;
  const inp = ctx.input;
  const jog = ctx.player;
  inp.locked = true;
  ctx.settings.set?.('musicVolume', 0.2);

  const V = ctx.camera.position.constructor;
  const dirTmp = new V();
  let t = 0, fase = 0, tRepor = 0;
  const M = window.__miolo;
  M.alvoSolo = 0; M.alvoDrone = 0;

  M.piloto = () => {
    t += 1 / 60; fase += 1 / 60;
    const ws = jog.weapons;
    if (ws && ws.reserve < 30) ws.slots[ws.index].reserve = 300;
    if (ws && ws.ammo === 0 && !ws.reloading) inp._pressedThisFrame.add('KeyR');

    /* --- repovoamento: o campo tem de FICAR cheio, nao encher e esvaziar.
     * O relato e de carga em REGIME. Se o boneco limpa o campo, a medicao
     * vira campo vazio e nao mede nada. */
    tRepor -= 1 / 60;
    if (tRepor <= 0 && (M.alvoSolo || M.alvoDrone)) {
      tRepor = 1.5;
      let vs = 0, vd = 0;
      for (const e of ctx.ai.vivos) { if (!e.alive) continue; if (e.eDrone) vd++; else vs++; }
      if (vs < M.alvoSolo) ctx.ai.spawnOnda(M.alvoSolo - vs, 13, 42, 'solo');
      if (vd < M.alvoDrone) ctx.ai.spawnOnda(M.alvoDrone - vd, 15, 42, 'drone');
      ctx.ai.convergirNoJogador(1.1);
    }

    let alvo = null, melhor = 1e9;
    for (const e of ctx.ai.vivos) {
      if (!e.alive) continue;
      const d = e.pos.distanceToSquared(jog.position);
      if (d < melhor) { melhor = d; alvo = e; }
    }
    const rig = jog.rig;
    const sens = ctx.settings?.sensitivity ?? 0.0022;
    if (alvo && rig) {
      dirTmp.subVectors(alvo.pos, jog.eyePosition);
      if (!alvo.eDrone) dirTmp.y += 1.1;
      const yawAlvo = Math.atan2(-dirTmp.x, -dirTmp.z);
      const pitchAlvo = Math.atan2(dirTmp.y, Math.hypot(dirTmp.x, dirTmp.z));
      let d = yawAlvo - rig.yaw;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      const dp = pitchAlvo - rig.pitch;
      const passoMax = 0.075;
      const giro = Math.max(-passoMax, Math.min(passoMax, d * 0.22));
      const sobe = Math.max(-passoMax, Math.min(passoMax, dp * 0.22));
      inp.mouseDX = -giro / sens;
      inp.mouseDY = -sobe / sens;
      const perto = Math.hypot(d, dp) < 0.10;
      inp.buttons[0] = perto && Math.sqrt(melhor) < 55 && !!ws && ws.ammo > 0;
      inp.buttons[2] = Math.hypot(d, dp) < 0.25 && Math.sqrt(melhor) > 18;
    } else {
      inp.mouseDX = 0.9 / sens * (Math.sin(t * 0.31) > 0 ? 1 : -1) * 0.02;
      inp.buttons[0] = false; inp.buttons[2] = false;
    }

    const c = fase % 8;
    inp.keys.delete('KeyA'); inp.keys.delete('KeyD');
    inp.keys.delete('ShiftLeft'); inp.keys.delete('KeyC');
    inp.keys.add('KeyW');
    if (c < 2.5) inp.keys.add('ShiftLeft');
    else if (c < 4) inp.keys.add('KeyA');
    else if (c < 5.5) inp.keys.add('KeyD');
    else if (c < 6.5) inp.keys.add('KeyC');
    if (Math.abs(c - 7.0) < 1 / 60) inp._pressedThisFrame.add('Space');
    if (Math.abs(c - 5.0) < 1 / 60) inp._pressedThisFrame.add('KeyQ');
  };
});

/* ===================================================================== *
 * 3. ROTEIRO — separa o custo do bando do custo do drone                 *
 * ===================================================================== *
 * A pergunta do jogador tem dois termos ("muito player" E "drone"). Para
 * responder qual pesa quanto, cada termo entra sozinho antes de entrarem
 * juntos, com o campo limpo entre um e outro, e o mesmo piloto nos tres.  */
const TODOS = [
  ['vazio', 8, { solo: 0, drone: 0 }],
  ['so-chao-12', 55, { solo: 12, drone: 0 }],
  ['so-drone-10', 55, { solo: 0, drone: 10 }],
  ['misto-12x6', 100, { solo: 12, drone: 6 }],
  ['stress-14x10', 82, { solo: 14, drone: 10 }],
];
const roteiro = CENA ? TODOS.filter((r) => r[0].includes(CENA) || r[0] === 'vazio') : TODOS;

await page.evaluate(() => {
  const ctx = window.__game.ctx;
  ctx.menu?.hideAll?.();
  ctx.state = 'jogando';
  ctx.bus.emit('game:start', {});
  // Quem povoa e o roteiro, nao a Progressao: a composicao tem de ser a
  // pedida, e nao a que a curva de ondas escolher no momento.
  if (ctx.progressao) ctx.progressao.fase = 'fim';
  ctx.ai.spawnAutomatico = false;
  window.__miolo.rodando = true;
  window.__miolo.marcar('gravacao-comeca');
});

const escala = MEDIR / roteiro.reduce((a, r) => a + r[1], 0);
process.stdout.write('medindo');
for (const [nome, seg, comp] of roteiro) {
  await page.evaluate(({ nome, comp }) => {
    const ctx = window.__game.ctx;
    const M = window.__miolo;
    M.marcar(nome);
    ctx.ai.reset();
    ctx.ai.maxVivos = Math.max(10, comp.solo + comp.drone);
    ctx.ai.maxDrones = comp.drone;
    ctx.ai.maxAtiradores = 4;
    M.alvoSolo = comp.solo; M.alvoDrone = comp.drone;
    if (comp.solo) ctx.ai.spawnOnda(comp.solo, 13, 42, 'solo');
    if (comp.drone) ctx.ai.spawnOnda(comp.drone, 15, 42, 'drone');
    ctx.ai.convergirNoJogador(1.2);
  }, { nome, comp });
  const ms = Math.max(5000, Math.round(seg * escala * 1000));
  for (let s = 0; s < ms; s += 5000) {
    await page.waitForTimeout(Math.min(5000, ms - s));
    process.stdout.write('.');
  }
}
console.log('');

const bruto = await page.evaluate(() => {
  const M = window.__miolo;
  M.rodando = false;
  const ctx = window.__game.ctx;
  return {
    Q: M.Q, ordem: M.ordem, marcos: M.marcos,
    dano: window.__dano,
    navStats: ctx.ai.nav?.stats ?? null,
  };
});

await browser.close();
vite.kill();

/* ===================================================================== *
 * 4. ANALISE                                                            *
 * ===================================================================== */
const Q = bruto.Q;
const ORD = bruto.ordem;
const NF = ORD.length;
const BASE = 17;
const col = {
  t: 0, dt: 1, aiTot: 2, heap: 3, vivos: 4, drones: 5, atirando: 6, ragd: 7, longe: 8,
  prog: 9, busca: 10, nos: 11, cacheHit: 12, falha: 13, rc: 14, sc: 15, cs: 16,
};
const iMS = (q, n) => q[BASE + ORD.indexOf(n)];
const iRAIO = (q, n) => q[BASE + NF + ORD.indexOf(n)];
const iMSCOL = (q, n) => q[BASE + 2 * NF + ORD.indexOf(n)];

const l = (s = '') => console.log(s);
const n2 = (x) => (x == null || !isFinite(x) ? '-' : x.toFixed(2));

if (Q.length < 100) { l('MEDICAO INVALIDA: so ' + Q.length + ' quadros.'); process.exit(1); }

const pctDe = (arr, p) => {
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

l('');
l('=========================================================================');
l('AFERICAO DO INSTRUMENTO');
l('=========================================================================');
l('  GPU        ' + aferi.renderer);
l('  preset     ' + aferi.preset + '  render ' + aferi.largura + 'x' + aferi.altura);
l('  boot       ' + (bootMs / 1000).toFixed(1) + ' s   pool  solo=' + aferi.poolSolo + ' drone=' + aferi.poolDrone);
l('  relogio    resolucao ' + (aferi.resolucaoRelogio * 1000).toFixed(1) + ' us'
  + '   isolamento de origem ' + (aferi.isolado ? 'LIGADO' : 'DESLIGADO (quebra por fase INVALIDA)'));
l('  quadros    ' + Q.length + '  em ' + ((Q[Q.length - 1][col.t] - Q[0][col.t]) / 1000).toFixed(0) + ' s'
  + '   dano tomado ' + Math.round(bruto.dano));
l('  fases      ' + ORD.join(' '));

/* --- por trecho do roteiro --- */
const marcos = bruto.marcos.filter((m) => m.nome !== 'gravacao-comeca');
const trechos = [];
for (let i = 0; i < marcos.length; i++) {
  const a = marcos[i].q;
  const b = i + 1 < marcos.length ? marcos[i + 1].q : Q.length;
  if (b - a > 30) trechos.push({ nome: marcos[i].nome, a: a + 20, b });   // 20 quadros de folga do spawn
}

const SOMA_IA = ['percepcao', 'nav', 'nav.buscar', 'nav.astar', 'nav.suaviza',
  'solo.pensar', 'solo.cobertura', 'solo.vigiar', 'solo.mover', 'solo.apontar', 'solo.anim',
  'solo.tiro', 'solo.abrirFogo', 'vagaDeFogo', 'audicao',
  'drone.pensar', 'drone.voo', 'drone.apontar', 'drone.pose', 'drone.cair', 'drone.tiro',
  'rotores', 'zumbido', 'spawn', 'ragdoll', 'bus.emit',
  'aud.zumbidoEnxame', 'aud.tiro', 'aud.grito', 'aud.impacto', 'aud.droneInvestida',
  'aud.droneQueda', 'aud.recarga'].filter((n) => ORD.includes(n));

l('');
l('=========================================================================');
l('QUADRO POR TRECHO — p50 / p99 / PIOR, nunca media');
l('=========================================================================');
l('  trecho            vivos drn |   dt p50   p99    PIOR |  ai p50   p99   PIOR | cpu p50  p99  PIOR | raios/q p50 p99 max');
for (const tr of trechos) {
  const S = Q.slice(tr.a, tr.b);
  const dts = S.map((q) => q[col.dt]);
  const ais = S.map((q) => q[col.aiTot]);
  const rs = S.map((q) => q[col.rc] + q[col.sc] + q[col.cs]);
  const cpus = S.map((q) => { let x = 0; for (const f of ORD) x += iMS(q, f); return x; });
  const vv = S.reduce((a, q) => a + q[col.vivos], 0) / S.length;
  const dd = S.reduce((a, q) => a + q[col.drones], 0) / S.length;
  l('  ' + tr.nome.padEnd(17) + String(vv.toFixed(1)).padStart(5) + String(dd.toFixed(1)).padStart(4) + ' |'
    + n2(pctDe(dts, 0.5)).padStart(8) + n2(pctDe(dts, 0.99)).padStart(7) + n2(Math.max(...dts)).padStart(8) + ' |'
    + n2(pctDe(ais, 0.5)).padStart(8) + n2(pctDe(ais, 0.99)).padStart(6) + n2(Math.max(...ais)).padStart(7) + ' |'
    + n2(pctDe(cpus, 0.5)).padStart(8) + n2(pctDe(cpus, 0.99)).padStart(6) + n2(Math.max(...cpus)).padStart(6) + ' |'
    + String(Math.round(pctDe(rs, 0.5))).padStart(9) + String(Math.round(pctDe(rs, 0.99))).padStart(5)
    + String(Math.max(...rs)).padStart(5));
}

/* --- onde vai o tempo dentro do ai.update, por trecho --- */
for (const tr of trechos) {
  const S = Q.slice(tr.a, tr.b);
  if (!S.length) continue;
  l('');
  l('-------------------------------------------------------------------------');
  l('DENTRO DO ai.update — ' + tr.nome + '  (' + S.length + ' quadros)');
  l('-------------------------------------------------------------------------');
  const aiTot = S.map((q) => q[col.aiTot]);
  const linhas = [];
  let somaP50 = 0;
  for (const f of SOMA_IA) {
    const v = S.map((q) => iMS(q, f));
    const r = S.map((q) => iRAIO(q, f));
    const c = S.map((q) => iMSCOL(q, f));
    const m50 = pctDe(v, 0.5), m99 = pctDe(v, 0.99), mx = Math.max(...v);
    if (mx < 0.01 && m99 < 0.005) continue;
    somaP50 += m50;
    linhas.push({ f, m50, m99, mx, r50: pctDe(r, 0.5), r99: pctDe(r, 0.99), rmx: Math.max(...r), c50: pctDe(c, 0.5), cmx: Math.max(...c) });
  }
  linhas.sort((a, b) => b.m50 - a.m50);
  l('  fase             ms p50   p99    PIOR |  raios p50  p99  max | ms na colisao p50  max');
  for (const x of linhas) {
    l('  ' + x.f.padEnd(15) + n2(x.m50).padStart(7) + n2(x.m99).padStart(7) + n2(x.mx).padStart(8) + ' |'
      + String(x.r50).padStart(11) + String(x.r99).padStart(5) + String(x.rmx).padStart(5) + ' |'
      + n2(x.c50).padStart(15) + n2(x.cmx).padStart(7));
  }
  const resto50 = pctDe(aiTot, 0.5) - somaP50;
  l('  ' + '(resto do ai)'.padEnd(15) + n2(resto50).padStart(7));
  l('  ' + 'AI TOTAL'.padEnd(15) + n2(pctDe(aiTot, 0.5)).padStart(7) + n2(pctDe(aiTot, 0.99)).padStart(7)
    + n2(Math.max(...aiTot)).padStart(8));

  // navegacao
  const bs = S.map((q) => q[col.busca]), ns = S.map((q) => q[col.nos]);
  const fl = S.reduce((a, q) => a + q[col.falha], 0), hh = S.reduce((a, q) => a + q[col.cacheHit], 0);
  const tb = S.reduce((a, q) => a + q[col.busca], 0);
  l('  nav: buscas/quadro p50 ' + pctDe(bs, 0.5) + ' p99 ' + pctDe(bs, 0.99) + ' max ' + Math.max(...bs)
    + ' · nos/quadro p99 ' + pctDe(ns, 0.99) + ' max ' + Math.max(...ns)
    + ' · total ' + tb + ' buscas, ' + fl + ' falhas (' + (tb ? (100 * fl / tb).toFixed(0) : 0) + '%), '
    + hh + ' cache');
}

/* --- ORCAMENTO DE RAIOS: quem respeita e quem nao --- */
l('');
l('=========================================================================');
l('ORCAMENTO DE RAIOS — FICHAS_LOS = ' + aferi.fichas + ' por quadro');
l('=========================================================================');
const pior = trechos[trechos.length - 1] || { a: 0, b: Q.length, nome: '?' };
const S = Q.slice(pior.a, pior.b);
const dentro = S.map((q) => iRAIO(q, 'percepcao'));
const total = S.map((q) => q[col.rc] + q[col.sc] + q[col.cs]);
l('  trecho de referencia: ' + pior.nome);
l('  raios de PERCEPCAO (dentro do orcamento): p50 ' + pctDe(dentro, 0.5)
  + ' · p99 ' + pctDe(dentro, 0.99) + ' · max ' + Math.max(...dentro));
l('  raios TOTAIS no quadro:                   p50 ' + pctDe(total, 0.5)
  + ' · p99 ' + pctDe(total, 0.99) + ' · max ' + Math.max(...total));
const foraP99 = pctDe(total, 0.99) - pctDe(dentro, 0.99);
l('  ou seja: ' + foraP99 + ' raios/quadro no p99 FORA de qualquer orcamento ('
  + (100 * foraP99 / Math.max(1, pctDe(total, 0.99))).toFixed(0) + '% do total)');
l('');
l('  quem atira, no p99 do trecho (raios/quadro · ms na colisao p99):');
const porFase = ORD.map((f) => ({
  f, r: pctDe(S.map((q) => iRAIO(q, f)), 0.99),
  ms: pctDe(S.map((q) => iMSCOL(q, f)), 0.99),
  rmax: Math.max(...S.map((q) => iRAIO(q, f))),
})).filter((x) => x.r > 0 || x.rmax > 0).sort((a, b) => b.r - a.r);
for (const x of porFase) {
  l('    ' + x.f.padEnd(16) + String(x.r).padStart(5) + '  (max ' + String(x.rmax).padStart(4) + ')   '
    + n2(x.ms) + ' ms');
}

/* --- CAUDA: os 12 piores quadros e o que havia neles --- */
l('');
l('=========================================================================');
l('OS 12 PIORES QUADROS — anatomia');
l('=========================================================================');
const idx = Q.map((q, i) => i).sort((a, b) => Q[b][col.dt] - Q[a][col.dt]).slice(0, 12);
const lixoEm = (i) => {
  for (const k of [i, i + 1]) {
    if (k <= 0 || k >= Q.length) continue;
    if (Q[k][col.heap] - Q[k - 1][col.heap] < -2048) return true;
  }
  return false;
};
const nomeDoQuadro = (i) => {
  let n = '?';
  for (const m of bruto.marcos) if (m.q <= i) n = m.nome;
  return n;
};
l('  (LIXO = queda de heap > 2 MB neste quadro ou no seguinte; zero falso positivo no controle)');
l('  #    dt      ai   render  player  fora | raios  buscas  nos  falha | vivos drn  LIXO  trecho');
for (const i of idx) {
  const q = Q[i];
  let soma = 0;
  for (const f of ORD) soma += iMS(q, f);
  const fora = q[col.dt] - soma;
  l('  ' + String(i).padEnd(6) + n2(q[col.dt]).padStart(8) + n2(q[col.aiTot]).padStart(8)
    + n2(iMS(q, 'render')).padStart(8) + n2(iMS(q, 'player')).padStart(8) + n2(fora).padStart(7) + ' |'
    + String(q[col.rc] + q[col.sc] + q[col.cs]).padStart(6) + String(q[col.busca]).padStart(8)
    + String(q[col.nos]).padStart(7) + String(q[col.falha]).padStart(6) + ' |'
    + String(q[col.vivos]).padStart(6) + String(q[col.drones]).padStart(4)
    + (lixoEm(i) ? '   SIM' : '     -').padStart(6) + '  ' + nomeDoQuadro(i));
}

/* --- os 8 piores quadros DE ai.update, com a fase culpada --- */
l('');
l('  os 8 piores `ai.update`, com a fase que comeu o tempo:');
const idxAI = Q.map((q, i) => i).sort((a, b) => Q[b][col.aiTot] - Q[a][col.aiTot]).slice(0, 8);
for (const i of idxAI) {
  const q = Q[i];
  const fs = SOMA_IA.map((f) => ({ f, v: iMS(q, f) })).filter((x) => x.v > 0.05)
    .sort((a, b) => b.v - a.v).slice(0, 4);
  l('    #' + String(i).padEnd(6) + 'ai=' + n2(q[col.aiTot]).padStart(8) + ' ms  dt=' + n2(q[col.dt]).padStart(8)
    + '  raios=' + String(q[col.rc] + q[col.sc] + q[col.cs]).padStart(4)
    + '  A*=' + q[col.busca] + '/' + q[col.nos] + 'nos'
    + '  ->  ' + fs.map((x) => x.f + ' ' + n2(x.v)).join(' · '));
}

/* --- alocacao: subidas de heap (piso, nunca teto — ver NOTES secao 7) --- */
let subida = 0, quedas = 0, quedaGrande = 0;
for (let i = 1; i < Q.length; i++) {
  const d = Q[i][col.heap] - Q[i - 1][col.heap];
  if (d > 0) subida += d;
  else if (d < 0) { quedas++; if (d < -2048) quedaGrande++; }
}
l('');
l('=========================================================================');
l('ALOCACAO (piso, nunca teto — ver NOTES [CORE] secao 7)');
l('=========================================================================');
l('  soma das subidas de heap: ' + (subida / 1024).toFixed(1) + ' MB em ' + Q.length + ' quadros'
  + '  =  ' + (subida / Q.length).toFixed(0) + ' KB/quadro');
l('  quedas de heap: ' + quedas + '  (maiores que 2 MB: ' + quedaGrande + ')');
const ordDt = Q.map((q, i) => i).sort((a, b) => Q[b][col.dt] - Q[a][col.dt]);
const n50 = ordDt.slice(0, 50).filter(lixoEm).length;
const baseLixo = Q.map((q, i) => i).filter(lixoEm).length;
l('  dos 50 piores quadros, ' + n50 + ' tem coleta junto  (base: ' + baseLixo + ' de ' + Q.length
  + ' = ' + (100 * baseLixo / Q.length).toFixed(1) + '% dos quadros)');

writeFileSync(ROOT + '/tools/miolo.' + TAG + '.json', JSON.stringify({
  aferi, marcos: bruto.marcos, ordem: ORD, navStats: bruto.navStats, Q,
}));
l('');
l('  dump: tools/miolo.' + TAG + '.json');
