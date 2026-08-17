/**
 * audiolixo.mjs — o experimento que decide a causa raiz.
 *
 * audiolab mostrou 0.165 de carga com 8 pilhas de disparo TOCANDO, mas 1.88
 * quando as mesmas 8 vozes acumulam 30 disparos cada ao longo do render. A
 * diferenca nao e som tocando: e no PARADO que continua pendurado no grafo.
 *
 * Aqui N triplas (fonte + filtro + ganho) tocam 0.15 s e depois ficam mudas
 * ate o fim do render. Duas variantes:
 *
 *   conectado    ninguem desconecta nada — e o que o motor faz hoje
 *   desconectado as mesmas triplas sao desconectadas em t=0.4 s (a correcao)
 *
 * Se a carga sobe com N no primeiro caso e fica plana no segundo, a causa raiz
 * e "no que terminou continua no grafo" e a correcao e desconectar.
 *
 * Uso: node tools/audiolixo.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const ROOT = process.cwd(), PORT = 5234;
const vite = spawn(process.execPath,
  [ROOT + '/node_modules/vite/bin/vite.js', '--config', ROOT + '/tools/vite.diag.config.js',
    '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r, j) => {
  let o = ''; const h = d => { o += d; if (/ready in/.test(o)) r(); };
  vite.stdout.on('data', h); vite.stderr.on('data', h);
  setTimeout(() => j(new Error('vite t/o')), 40000);
});
const b = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 400, height: 300 } });
p.on('pageerror', e => console.log('PAGEERR:', e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/tools/audiolab.html`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__lab, { timeout: 30000 });

const r = await p.evaluate(async () => {
  const { AudioEngine } = await import('/src/fx/AudioEngine.js');
  const SR = 48000, DUR = 2;

  const mede = async (N, solta) => {
    const a = new OfflineAudioContext(2, SR * DUR, SR);
    const buf = AudioEngine.prototype._criaRuido.call({ actx: a }, 2.0);
    const bus = a.createGain(); bus.gain.value = 0.02; bus.connect(a.destination);
    const todos = [];
    for (let i = 0; i < N; i++) {
      const s = a.createBufferSource(); s.buffer = buf; s.loop = true;
      s.playbackRate.value = 1 + (i % 7) * 0.03;
      const f = a.createBiquadFilter(); f.type = 'bandpass';
      f.frequency.value = 400 + (i % 40) * 90; f.Q.value = 1.2;
      const g = a.createGain(); g.gain.value = 0.02;
      s.connect(f); f.connect(g); g.connect(bus);
      s.start(0, 0, 0.15);              // toca 150 ms e acaba
      todos.push(s, f, g);
    }
    if (solta) {
      // a correcao: em t=0.4 s (bem depois do som acabar) tudo sai do grafo
      a.suspend(0.4).then(() => {
        for (const n of todos) { try { n.disconnect(); } catch { /* ja solto */ } }
        a.resume();
      });
    }
    const t = performance.now();
    await a.startRendering();
    return +(((performance.now() - t) / 1000) / DUR).toFixed(3);
  };
  const med = async (N, s) => { const v = [await mede(N, s), await mede(N, s), await mede(N, s)]; return v.sort((x, y) => x - y)[1]; };

  const out = [];
  for (const N of [0, 200, 500, 1000, 2000, 4000]) {
    out.push({ N, conectado: await med(N, false), desconectado: await med(N, true) });
  }
  return out;
});

console.log('\nCUSTO DO QUE JA TERMINOU MAS CONTINUA NO GRAFO — carga = parede / audio\n');
console.log('   nos parados | conectado (hoje) | desconectado (correcao)');
console.log('-'.repeat(60));
for (const o of r) {
  console.log(`${String(o.N * 3).padStart(14)} | ${String(o.conectado).padStart(16)} | ${String(o.desconectado).padStart(23)}`);
}
await b.close(); vite.kill();
