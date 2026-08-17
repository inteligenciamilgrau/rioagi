/**
 * audiocamada.mjs — de onde vem o custo DENTRO da pilha de camadas do tiro?
 *
 * audiolab.mjs mostrou que a cadeia de voz vazia e barata (carga ~0.09 com 32
 * cadeias) e que os convolvers e o HRTF sao secundarios, mas que a PILHA DE
 * CAMADAS de disparo custa de 2x a 8x o tempo real. Falta saber qual pedaco.
 *
 * Aqui K pilhas ficam ATIVAS o render inteiro (nada de agendar centenas de
 * disparos e medir lixo acumulado), e cada variante muda UMA coisa:
 *
 *   base        como o motor faz hoje
 *   pr=1        playbackRate exatamente 1.0 nas fontes de ruido
 *               (playbackRate != 1 liga o reamostrador interpolante do Chrome)
 *   bq-estatico frequencia do bandpass fixa, sem varredura
 *               (AudioParam de BiquadFilter e a-rate: automatizada, o Chrome
 *                recalcula os coeficientes do filtro AMOSTRA A AMOSTRA)
 *   env-estat.  ganhos fixos, sem envelope exponencial
 *   so-fontes   so as 6 fontes + ganhos, sem nenhum filtro
 *   so-filtros  1 fonte alimentando os 6 filtros
 *
 * Uso: node tools/audiocamada.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const ROOT = process.cwd(), PORT = 5233;
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
  const proto = AudioEngine.prototype;
  const SR = 48000, DUR = 3;

  const mede = async (K, modo) => {
    const a = new OfflineAudioContext(2, SR * DUR, SR);
    const buf = proto._criaRuido.call({ actx: a }, 2.0);
    const bus = a.createGain(); bus.gain.value = 0.02; bus.connect(a.destination);

    const fonte = (taxa) => {
      const s = a.createBufferSource(); s.buffer = buf; s.loop = true;
      s.playbackRate.value = (modo === 'pr=1') ? 1.0 : taxa;
      s.start(0); return s;
    };
    const filtro = (tipo, f, q, varre) => {
      const b = a.createBiquadFilter(); b.type = tipo; b.frequency.value = f; b.Q.value = q;
      if (varre && modo !== 'bq-estatico') {
        // varredura continua, como o corpo do tiro faz a cada disparo
        for (let t = 0; t < DUR; t += 0.1) {
          b.frequency.setValueAtTime(f, t);
          b.frequency.exponentialRampToValueAtTime(f * 0.12, t + 0.09);
        }
      }
      return b;
    };
    const env = (v) => {
      const g = a.createGain();
      if (modo === 'env-estat.') { g.gain.value = v; return g; }
      g.gain.value = 0.0001;
      for (let t = 0; t < DUR; t += 0.1) {
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(v, t + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      }
      return g;
    };

    for (let i = 0; i < K; i++) {
      const ent = a.createGain(); ent.gain.value = 0.2; ent.connect(bus);
      if (modo === 'so-fontes') {
        for (const tx of [1.07, 1.0, 1.0, 1.2]) { const s = fonte(tx); const g = env(0.3); s.connect(g); g.connect(ent); }
        const o1 = a.createOscillator(); o1.frequency.value = 104; o1.start(0);
        const o2 = a.createOscillator(); o2.type = 'triangle'; o2.frequency.value = 208; o2.start(0);
        o1.connect(env(0.2)).connect(ent); o2.connect(env(0.1)).connect(ent);
        continue;
      }
      if (modo === 'so-filtros') {
        const s = fonte(1.07);
        const cad = [filtro('highpass', 3000, 0.7), filtro('bandpass', 1900, 0.95, true),
        filtro('lowpass', 6500, 0.5), filtro('bandpass', 3400, 7), filtro('highpass', 4200, 0.9),
        filtro('bandpass', 1500, 1.2)];
        for (const f of cad) { s.connect(f); const g = env(0.15); f.connect(g); g.connect(ent); }
        continue;
      }
      // pilha completa do disparo
      { const s = fonte(1.07); const f = filtro('highpass', 3000, 0.7); const g = env(0.3); s.connect(f); f.connect(g); g.connect(ent); }
      { const s = fonte(1.0); const f = filtro('bandpass', 1900, 0.95, true); const l = filtro('lowpass', 6500, 0.5); const g = env(0.3); s.connect(f); f.connect(l); l.connect(g); g.connect(ent); }
      { const o = a.createOscillator(); o.frequency.value = 104; o.start(0); const g = env(0.2); o.connect(g); g.connect(ent); }
      { const o = a.createOscillator(); o.type = 'triangle'; o.frequency.value = 208; o.start(0); const g = env(0.1); o.connect(g); g.connect(ent); }
      { const s = fonte(1.0); const f = filtro('bandpass', 3400, 7); const g = env(0.2); s.connect(f); f.connect(g); g.connect(ent); }
      { const s = fonte(1.2); const f = filtro('highpass', 4200, 0.9); const g = env(0.2); s.connect(f); f.connect(g); g.connect(ent); }
    }
    const t = performance.now();
    await a.startRendering();
    return +(((performance.now() - t) / 1000) / DUR).toFixed(3);
  };
  const med = async (K, m) => { const v = [await mede(K, m), await mede(K, m), await mede(K, m)]; return v.sort((x, y) => x - y)[1]; };

  const MODOS = ['base', 'pr=1', 'bq-estatico', 'env-estat.', 'so-fontes', 'so-filtros'];
  const out = [];
  for (const K of [4, 8, 16]) {
    const l = { K };
    for (const m of MODOS) l[m] = await med(K, m);
    out.push(l);
  }
  return { out, MODOS };
});

console.log('\nCUSTO POR PILHA DE CAMADAS ATIVA — carga = parede / audio\n');
console.log('pilhas | ' + r.MODOS.map(m => m.padStart(11)).join(' | '));
console.log('-'.repeat(90));
for (const l of r.out) console.log(String(l.K).padStart(6) + ' | ' + r.MODOS.map(m => String(l[m]).padStart(11)).join(' | '));
await b.close(); vite.kill();
