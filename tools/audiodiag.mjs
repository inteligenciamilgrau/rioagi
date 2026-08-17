/**
 * audiodiag.mjs — diagnostico de PERFORMANCE de audio no jogo real.
 *
 * Mede, num tiroteio sintetico com 0/4/8/12 hostis:
 *   A) nos WebAudio criados por segundo (por tipo)
 *   B) nos AINDA VIVOS (criados - coletados pelo GC), amostrado a cada segundo.
 *      Este e o tamanho REAL do grafo que a thread de audio processa. Se sobe
 *      sem parar, achamos o vazamento.
 *   C) `AudioEngine.vozes` vs. realidade
 *   D) TRAVADAS da thread de audio: amostrando (performance.now, currentTime)
 *      a cada ~32 ms, um intervalo em que o relogio de audio anda MENOS que o
 *      relogio de parede e um buffer que nao foi entregue — e isso que o ouvido
 *      escuta como estalo. Conta quantas travadas e quanto audio se perdeu.
 *   E) tempo de CPU da main thread dentro das chamadas de audio.
 *
 * Uso: node tools/audiodiag.mjs [rotulo]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const ROTULO = process.argv[2] || '';
const ROOT = process.cwd(), PORT = 5231;
// HMR desligado: outros agentes editam src/ ao mesmo tempo e um full-reload no
// meio da medicao destroi o contexto de execucao.
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
p.on('console', m => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text().split('\n')[0].slice(0, 200)); });
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
try {
  await p.waitForFunction(() => window.__game?.ready, null, { timeout: 180000, polling: 500 });
} catch (e) {
  console.log('jogo nao ficou pronto:', await p.evaluate(() => window.__game?.error || '(sem __game)'));
  throw e;
}
await p.mouse.click(400, 300);
await p.waitForTimeout(1500);

const r = await p.evaluate(async () => {
  const ctx = window.__game.ctx, A = ctx.audio;
  const esperar = (s) => new Promise(r => setTimeout(r, s * 1000));

  /* --- instrumentacao: criacao e sobrevivencia de nos ------------------- */
  const criados = {};
  let nCriados = 0, nColetados = 0;
  const reg = new FinalizationRegistry(() => { nColetados++; });
  const proto = Object.getPrototypeOf(A.actx);
  const METODOS = ['createGain', 'createBiquadFilter', 'createPanner', 'createBufferSource',
    'createOscillator', 'createConvolver', 'createDelay', 'createWaveShaper',
    'createStereoPanner', 'createDynamicsCompressor'];
  for (const m of METODOS) {
    const orig = proto[m];
    if (!orig) continue;
    proto[m] = function (...a) {
      const n = orig.apply(this, a);
      criados[m] = (criados[m] || 0) + 1; nCriados++;
      reg.register(n, m);
      return n;
    };
  }
  const vivos = () => nCriados - nColetados;

  /* --- CPU da main thread dentro das chamadas de audio ------------------ */
  let cpuMs = 0;
  const cron = (nome) => { const o = A[nome].bind(A); return (...a) => { const t = performance.now(); const r = o(...a); cpuMs += performance.now() - t; return r; }; };
  const tiroT = cron('tiro'), passoT = cron('passo'), impactoT = cron('impacto');

  /* --- quantos eventos sao DESCARTADOS pelo teto de vozes --------------- */
  let pedidos = 0, negados = 0, ducks = 0;
  const _vozOrig = A._voz.bind(A);
  A._voz = (...a) => { pedidos++; const r = _vozOrig(...a); if (!r) negados++; return r; };
  const _duckOrig = A._duck.bind(A);
  A._duck = (...a) => { ducks++; return _duckOrig(...a); };

  ctx.settings.set('musicVolume', 0);
  ctx.settings.set('sfxVolume', 1);
  ctx.state = 'jogando';

  const V = (x, y, z) => new (ctx.camera.position.constructor)(x, y, z);

  const cenario = async (nHostis, segundos) => {
    for (const k of Object.keys(criados)) delete criados[k];
    cpuMs = 0;
    const base = nCriados, baseCol = nColetados;
    const cam = ctx.camera.position;
    const hostis = [];
    for (let i = 0; i < nHostis; i++) {
      const ang = (i / Math.max(1, nHostis)) * Math.PI * 2;
      const d = 8 + (i % 4) * 6;
      hostis.push(V(cam.x + Math.cos(ang) * d, cam.y, cam.z + Math.sin(ang) * d));
    }

    pedidos = 0; negados = 0; ducks = 0;

    /* --- detector de travada da thread de audio ------------------------- */
    let travadas = 0, audioPerdido = 0, maxLacuna = 0;
    let lw = performance.now(), la = A.actx.currentTime;
    /* --- balanco do ducking: quanto o busSfx e sacudido ------------------ */
    let gMin = 9, gMax = -9, puxoes = 0, gAnt = A.busSfx.gain.value;
    const amostra = setInterval(() => {
      const w = performance.now(), a = A.actx.currentTime;
      const dw = (w - lw) / 1000, da = a - la;
      lw = w; la = a;
      if (dw > 0.004) {
        const lacuna = dw - da;                 // segundos de audio nao entregues
        // 30% do intervalo faltando = buraco audivel, nao jitter de relogio
        if (lacuna > dw * 0.30 && lacuna > 0.006) {
          travadas++; audioPerdido += lacuna;
          if (lacuna > maxLacuna) maxLacuna = lacuna;
        }
      }
      const g = A.busSfx.gain.value;
      if (g < gMin) gMin = g;
      if (g > gMax) gMax = g;
      if (Math.abs(g - gAnt) > 0.08) puxoes++;
      gAnt = g;
    }, 8);

    const t0w = performance.now(), t0a = A.actx.currentTime;
    let tick = 0;
    const serieVivos = [], serieVozes = [];
    const iv = setInterval(() => {
      tick++;
      for (let i = 0; i < hostis.length; i++) {
        const h = hostis[i];
        tiroT('fuzil', h, false);                       // ~600 rpm
        if (tick % 2 === 0) impactoT('concreto', h);
        if (tick % 5 === i % 5) passoT('concreto', h, true);
      }
      if (tick % 10 === 0) tiroT('fuzil', null, true);   // jogador
    }, 100);

    for (let s = 0; s < segundos; s++) {
      await esperar(1);
      serieVivos.push(vivos());
      serieVozes.push(A.vozes);
    }
    clearInterval(iv); clearInterval(amostra);

    const wall = (performance.now() - t0w) / 1000;
    const audio = A.actx.currentTime - t0a;
    const criadosSnap = { ...criados };
    const total = nCriados - base;

    // deixa a cauda passar; NAO forca GC aqui (queremos o estado natural)
    await esperar(3.0);
    const vivosRepouso = vivos();
    if (window.gc) { window.gc(); await esperar(0.4); window.gc(); await esperar(0.4); }
    const vivosPosGC = vivos();

    return {
      nHostis, criados: criadosSnap, totalCriados: total,
      criadosPorSeg: +(total / segundos).toFixed(0),
      coletadosDurante: nColetados - baseCol,
      serieVivos, serieVozes, vivosRepouso, vivosPosGC,
      travadas, audioPerdidoMs: +(audioPerdido * 1000).toFixed(0),
      maxLacunaMs: +(maxLacuna * 1000).toFixed(1),
      derivaMs: +((wall - audio) * 1000).toFixed(0),
      cpuPct: +(cpuMs / (segundos * 1000) * 100).toFixed(1),
      pedidos, negados, descartePct: +(negados / Math.max(1, pedidos) * 100).toFixed(0),
      ducks, gMin: +gMin.toFixed(3), gMax: +gMax.toFixed(3), puxoes,
    };
  };

  const out = [];
  for (const n of [0, 4, 8, 12]) out.push(await cenario(n, 10));
  return { out, sampleRate: A.actx.sampleRate };
});

console.log(`\n=== ${ROTULO || 'medicao'} ===   sampleRate=${r.sampleRate}`);
console.log('\nhostis | criados/s | coletados | vivos (por segundo)                         | repouso | pos-GC');
console.log('-'.repeat(112));
for (const o of r.out) {
  console.log(`${String(o.nHostis).padStart(6)} | ${String(o.criadosPorSeg).padStart(9)} | ${String(o.coletadosDurante).padStart(9)} | ` +
    `${o.serieVivos.join(',').padEnd(43)} | ${String(o.vivosRepouso).padStart(7)} | ${String(o.vivosPosGC).padStart(6)}`);
}
console.log('\nhostis | TRAVADAS | audio perdido | maior lacuna | deriva | cpu main | vozes');
console.log('-'.repeat(100));
for (const o of r.out) {
  console.log(`${String(o.nHostis).padStart(6)} | ${String(o.travadas).padStart(8)} | ${String(o.audioPerdidoMs + ' ms').padStart(13)} | ` +
    `${String(o.maxLacunaMs + ' ms').padStart(12)} | ${String(o.derivaMs + 'ms').padStart(6)} | ${String(o.cpuPct + '%').padStart(8)} | ${o.serieVozes.join(',')}`);
}
console.log('\nhostis | pedidos de voz | negados | % descarte | ducks | busSfx min..max | puxoes de ganho');
console.log('-'.repeat(104));
for (const o of r.out) {
  console.log(`${String(o.nHostis).padStart(6)} | ${String(o.pedidos).padStart(14)} | ${String(o.negados).padStart(7)} | ` +
    `${String(o.descartePct + '%').padStart(10)} | ${String(o.ducks).padStart(5)} | ${String(o.gMin + '..' + o.gMax).padStart(15)} | ${String(o.puxoes).padStart(15)}`);
}
console.log('\ncriacao por tipo (12 hostis, 10 s):');
const d = r.out[r.out.length - 1].criados;
for (const k of Object.keys(d).sort((a, b) => d[b] - d[a])) console.log(`   ${k.padEnd(24)} ${d[k]}`);

await b.close(); vite.kill();
