/**
 * audiovarre.mjs — o teto de vozes, medido DENTRO DO JOGO.
 *
 * Por que existe, se ja ha o audioteto.mjs: porque a bancada offline MENTE sobre
 * o custo absoluto. OfflineAudioContext renderiza em blocos grandes, sem prazo e
 * sem disputar a maquina com render 3D, fisica e IA; a thread de audio de
 * verdade trabalha em quanta de 128 amostras com um buffer de ~10 ms
 * (latencyHint 'interactive'), onde o custo FIXO por no pesa muito mais. A
 * bancada serve para comparar caminhos (camada a camada x cache); nao serve para
 * dizer quantas vozes cabem.
 *
 * Aqui a medida e a unica que decide isso: DERIVA entre o relogio de parede e o
 * relogio de audio ao longo do cenario. Se o relogio de audio anda menos que o
 * de parede, a thread nao entregou buffer — e isso, e so isso, e o estalo.
 * Deriva perto de zero = folga; deriva de segundos = a placa nao da conta.
 *
 * Varre configuracoes de (teto HRTF, teto equalpower) com o MESMO tiroteio
 * sintetico, na mesma pagina e na mesma sessao, para que so o teto mude. Tres
 * passagens em ordens rotacionadas, e o que vale e o MINIMO de cada
 * configuracao: a maquina esta disputada por varios agentes, entao uma medida
 * alta pode ser lentidao alheia, mas uma medida baixa nao pode ser sorte —
 * ninguem entrega audio mais rapido que o proprio custo.
 *
 * Uso: node tools/audiovarre.mjs [hostis]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const HOSTIS = +(process.argv[2] || 8);
const ROOT = process.cwd(), PORT = 5237;
const vite = spawn(process.execPath,
  [ROOT + '/node_modules/vite/bin/vite.js', '--config', ROOT + '/tools/vite.diag.config.js',
    '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r, j) => {
  let o = ''; const h = d => { o += d; if (/ready in/.test(o)) r(); };
  vite.stdout.on('data', h); vite.stderr.on('data', h);
  setTimeout(() => j(new Error('vite t/o')), 40000);
});

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--js-flags=--expose-gc', '--autoplay-policy=no-user-gesture-required'],
});
const p = await b.newPage({ viewport: { width: 800, height: 600 } });
p.on('pageerror', e => console.log('PAGEERR:', e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__game?.ready, null, { timeout: 180000, polling: 500 });
await p.mouse.click(400, 300);
await p.waitForTimeout(1500);

const r = await p.evaluate(async ({ HOSTIS }) => {
  const ctx = window.__game.ctx, A = ctx.audio;
  const esperar = (s) => new Promise(r => setTimeout(r, s * 1000));
  ctx.settings.set('musicVolume', 0);
  ctx.settings.set('sfxVolume', 1);
  ctx.state = 'jogando';

  let pedidos = 0, negados = 0;
  const _vozOrig = A._voz.bind(A);
  A._voz = (...a) => { pedidos++; const r = _vozOrig(...a); if (!r) negados++; return r; };

  /** Ajusta os tetos e DESMONTA as cadeias que sobram, para poder descer. */
  const tetos = (h, e) => {
    A.tetos.hrtf = h; A.tetos.eq = e;
    for (const [pool, max] of [[A._poolHrtf, h], [A._poolEq, e]]) {
      while (pool.length > max) {
        const v = pool.pop();
        A._liberaVoz(v);
        A._varreLixo(v, 0, Infinity); A._varreLixo(v, 1, Infinity);
        try { v.saida.disconnect(); } catch { /* ja solto */ }
        try { v.mix.disconnect(); } catch { /* ja solto */ }
      }
    }
  };

  const V = (x, y, z) => new (ctx.camera.position.constructor)(x, y, z);

  const cenario = async (h, e, segundos) => {
    tetos(h, e);
    await esperar(1.2);                       // deixa a cauda anterior morrer
    const cam = ctx.camera.position;
    const alvos = [];
    for (let i = 0; i < HOSTIS; i++) {
      const ang = (i / Math.max(1, HOSTIS)) * Math.PI * 2;
      const d = 8 + (i % 4) * 6;
      alvos.push(V(cam.x + Math.cos(ang) * d, cam.y, cam.z + Math.sin(ang) * d));
    }
    pedidos = 0; negados = 0;

    let travadas = 0, perdido = 0;
    let lw = performance.now(), la = A.actx.currentTime;
    const amostra = setInterval(() => {
      const w = performance.now(), a = A.actx.currentTime;
      const dw = (w - lw) / 1000, da = a - la; lw = w; la = a;
      if (dw > 0.004) {
        const lac = dw - da;
        if (lac > dw * 0.30 && lac > 0.006) { travadas++; perdido += lac; }
      }
    }, 8);

    const t0w = performance.now(), t0a = A.actx.currentTime;
    let tick = 0; const serie = [];
    const iv = setInterval(() => {
      tick++;
      for (let i = 0; i < alvos.length; i++) {
        const t = alvos[i];
        A.tiro('fuzil', t, false);
        if (tick % 2 === 0) A.impacto('concreto', t);
        if (tick % 5 === i % 5) A.passo('concreto', t, true);
      }
      if (tick % 10 === 0) A.tiro('fuzil', null, true);
    }, 100);

    for (let s = 0; s < segundos; s++) { await esperar(1); serie.push(A.vozes); }
    clearInterval(iv); clearInterval(amostra);
    const wall = (performance.now() - t0w) / 1000;
    const audio = A.actx.currentTime - t0a;
    await esperar(1.5);
    return {
      h, e, total: h + e,
      derivaMs: +((wall - audio) * 1000).toFixed(0),
      travadas, perdidoMs: +(perdido * 1000).toFixed(0),
      pedidos, negados, descartePct: +(negados / Math.max(1, pedidos) * 100).toFixed(0),
      vozPico: Math.max(...serie),
    };
  };

  /* (HRTF, equalpower). Os quatro primeiros variam so o TOTAL com o HRTF fixo em
   * 6 (o valor antigo); os dois ultimos repetem totais ja vistos com outra
   * divisao binaural/equalpower, para separar as duas perguntas. */
  const CFG = [[6, 18], [12, 20], [12, 28], [16, 32], [16, 40], [16, 48]];
  const acc = {};
  /* Tres passagens em ordens ROTACIONADAS, e o numero que vale e o MINIMO de
   * cada configuracao. Com a maquina disputada, uma medida alta pode ser
   * lentidao alheia, mas uma medida baixa nao pode ser sorte: ninguem entrega
   * audio mais rapido que o proprio custo. O minimo e o custo intrinseco; a
   * dispersao entre passagens diz quanto do resto e ruido de contencao. */
  for (let passe = 0; passe < 3; passe++) {
    const ordem = CFG.slice(passe * 2).concat(CFG.slice(0, passe * 2));
    for (const [h, e] of ordem) {
      const o = await cenario(h, e, 6);
      (acc[h + ',' + e] ||= []).push(o);
    }
  }
  const out = [];
  for (const [h, e] of CFG) {
    const v = acc[h + ',' + e];
    const min = (k) => Math.min(...v.map(x => x[k]));
    out.push({
      h, e, total: h + e, derivaMs: min('derivaMs'), travadas: min('travadas'),
      perdidoMs: min('perdidoMs'),
      descartePct: Math.round(v.reduce((s, x) => s + x.descartePct, 0) / v.length),
      vozPico: Math.max(...v.map(x => x.vozPico)),
      derivas: v.map(x => x.derivaMs),
    });
  }
  return { out, hostis: HOSTIS };
}, { HOSTIS });

console.log(`\nVARREDURA DE TETO — ${r.hostis} hostis, 6 s por configuracao, 3 passagens rotacionadas`);
console.log('deriva = parede - relogio de audio, o MINIMO das 3. Perto de zero = a thread de audio deu conta.\n');
console.log(' hrtf | equalpwr | total | DERIVA (minimo) | deriva das 3 passagens | travadas | perdido | descarte | pico');
console.log('-'.repeat(118));
for (const o of r.out) {
  console.log(`${String(o.h).padStart(5)} | ${String(o.e).padStart(8)} | ${String(o.total).padStart(5)} | ` +
    `${String(o.derivaMs + ' ms').padStart(14)} | ${String(o.derivas.join(' / ') + ' ms').padStart(23)} | ` +
    `${String(o.travadas).padStart(8)} | ${String(o.perdidoMs + 'ms').padStart(7)} | ${String(o.descartePct + '%').padStart(8)} | ${String(o.vozPico).padStart(4)}`);
}
await b.close(); vite.kill();
