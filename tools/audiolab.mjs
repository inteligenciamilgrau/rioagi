/**
 * audiolab.mjs — micro-bancada OFFLINE do caminho de voz.
 *
 * Pergunta: quanto custa, em CPU da thread de audio, manter K vozes vivas?
 * OfflineAudioContext renderiza o mais rapido que a maquina consegue, entao
 *
 *     carga = tempo_de_parede / segundos_de_audio_renderizado
 *
 * mede direto quao perto do estouro a thread de audio esta. carga >= 1.0 =
 * impossivel em tempo real (estalo garantido). Na pratica, acima de ~0.35 ja e
 * zona de risco: em tempo real a thread de audio divide a maquina com render
 * 3D, fisica e IA, e o buffer de 10 ms do latencyHint 'interactive' nao perdoa.
 *
 * Variantes, para separar as culpas:
 *   orfa       cadeia montada e ABANDONADA, sem fonte tocando (o "vazamento")
 *   simples    cadeia + 1 fonte de ruido + os dois envios de reverb
 *   sem-envio  cadeia + 1 fonte, SEM envio de reverb  -> isola os convolvers
 *   tiro       cadeia + a pilha de camadas real de um disparo + envios
 *              === e o que o motor fazia ANTES da correcao ===
 *   tiro-HRTF  idem, com panner HRTF                  -> isola o custo do HRTF
 *   tiro-cache cadeia + 1 BufferSource por disparo (forma de onda pronta)
 *              === e o que o motor faz DEPOIS da correcao ===
 *
 * `tiro` contra `tiro-cache` e a medida antes/depois: mesma cadencia (600 rpm),
 * mesmas vozes, mesmos envios de reverb — muda so como o disparo e produzido.
 *
 * Roda com HMR desligado (tools/vite.diag.config.js) porque outros agentes
 * mexem em src/ ao mesmo tempo e um full-reload no meio mata a medicao.
 *
 * Uso: node tools/audiolab.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const ROOT = process.cwd(), PORT = 5232;
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
  args: ['--js-flags=--expose-gc', '--autoplay-policy=no-user-gesture-required'],
});
const p = await b.newPage({ viewport: { width: 400, height: 300 } });
p.on('pageerror', e => console.log('PAGEERR:', e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/tools/audiolab.html`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__lab, { timeout: 30000 });

const KS = [0, 8, 16, 24, 32, 48];
const r = await p.evaluate(async (KS) => {
  const { AudioEngine } = await import('/src/fx/AudioEngine.js');
  const proto = AudioEngine.prototype;
  const SR = 48000, DUR = 3;

  /* A forma de onda que o motor guarda em cache: sintetizada UMA vez, pelo
   * proprio `_camadasTiro`, exatamente como `_preRenderiza` faz em producao. */
  const fazBufTiro = async () => {
    const oc = new OfflineAudioContext(1, Math.ceil(0.6 * SR), SR);
    const eu = Object.create(proto);
    eu.actx = oc;
    eu.bufRuido = proto._criaRuido.call(eu, 0.8, 1);
    eu._vozAtual = null;
    const alvo = oc.createGain(); alvo.connect(oc.destination);
    proto._camadasTiro.call(eu, alvo, 0.002, proto._receita.call(eu, 'fuzil'), false);
    return await oc.startRendering();
  };
  const bufTiroPronto = await fazBufTiro();

  const mede = async (K, modo) => {
    const a = new OfflineAudioContext(2, SR * DUR, SR);
    const eu = { actx: a };                     // "this" minimo para os helpers

    // --- barramentos e os dois convolvers, iguais aos do jogo ------------
    const busSfx = a.createGain(); busSfx.connect(a.destination);
    const convRua = a.createConvolver(); convRua.normalize = true;
    convRua.buffer = proto._criaIR.call(eu, 1.35, 5.2, {
      taps: [[0.006, 0.62], [0.011, 0.48], [0.017, 0.4], [0.026, 0.3], [0.038, 0.22]], lp: 0.30, predelay: 0.004,
    });
    const envioRua = a.createGain(); envioRua.connect(convRua); convRua.connect(busSfx);
    const convBeco = a.createConvolver(); convBeco.normalize = true;
    convBeco.buffer = proto._criaIR.call(eu, 2.9, 2.1, {
      taps: [[0.031, 0.55], [0.062, 0.44], [0.094, 0.36], [0.127, 0.3], [0.161, 0.24], [0.198, 0.2], [0.243, 0.16], [0.301, 0.12]],
      lp: 0.085, predelay: 0.028,
    });
    const envioBeco = a.createGain(); envioBeco.connect(convBeco); convBeco.connect(busSfx);
    const bufRuido = proto._criaRuido.call(eu, 2.0);
    const bufTiro = bufTiroPronto;   // AudioBuffer atravessa contextos (mesmo sr)

    const ruido = (t0, dur, taxa = 1) => {
      const s = a.createBufferSource(); s.buffer = bufRuido; s.loop = true;
      s.playbackRate.value = taxa;
      s.start(t0, Math.random() * 1.9, dur); return s;
    };
    const filtro = (t, f, q) => { const b = a.createBiquadFilter(); b.type = t; b.frequency.value = f; b.Q.value = q; return b; };
    const ganho = (v) => { const g = a.createGain(); g.gain.value = v; return g; };

    for (let i = 0; i < K; i++) {
      const entrada = a.createGain(); entrada.gain.value = 0.05;
      const lp = filtro('lowpass', 4000, 0.2);
      const at = ganho(0.7);
      entrada.connect(lp); lp.connect(at);
      const pan = a.createPanner();
      pan.panningModel = (modo === 'tiro-HRTF') ? 'HRTF' : 'equalpower';
      pan.distanceModel = 'inverse'; pan.refDistance = 2.2; pan.rolloffFactor = 1.15; pan.maxDistance = 260;
      const ang = i * 0.7, d = 5 + (i % 20);
      pan.positionX.value = Math.cos(ang) * d; pan.positionZ.value = Math.sin(ang) * d;
      at.connect(pan);
      pan.connect(busSfx);
      if (modo !== 'sem-envio') {
        const g1 = ganho(0.4); pan.connect(g1); g1.connect(envioRua);
        const g2 = ganho(0.3); pan.connect(g2); g2.connect(envioBeco);
      }
      if (modo === 'orfa') continue;             // cadeia sem nada tocando

      if (modo === 'simples' || modo === 'sem-envio') {
        const s = ruido(0, DUR, 1); const g = ganho(0.3); s.connect(g); g.connect(entrada);
        continue;
      }
      if (modo === 'tiro-cache') {
        // forma de onda pronta: UM no por disparo, a cada 100 ms
        for (let t = 0; t < DUR; t += 0.1) {
          const s = a.createBufferSource(); s.buffer = bufTiro;
          s.playbackRate.value = 0.97 + Math.random() * 0.06;
          s.connect(entrada); s.start(t);
        }
        continue;
      }
      /* pilha real de um disparo: 4 fontes de ruido + 2 osciladores + filtros.
       * Repetida a cada 100 ms (600 rpm) durante todo o render. */
      for (let t = 0; t < DUR; t += 0.1) {
        const s1 = ruido(t, 0.09, 1.05); const h1 = filtro('highpass', 3000, 0.7); const gg1 = ganho(0.3);
        s1.connect(h1); h1.connect(gg1); gg1.connect(entrada);
        const s2 = ruido(t, 0.38, 1.0); const b2 = filtro('bandpass', 1900, 0.95);
        const l2 = filtro('lowpass', 6500, 0.5); const gg2 = ganho(0.3);
        s2.connect(b2); b2.connect(l2); l2.connect(gg2); gg2.connect(entrada);
        const o3 = a.createOscillator(); o3.frequency.value = 104; o3.start(t); o3.stop(t + 0.21);
        const gg3 = ganho(0.2); o3.connect(gg3); gg3.connect(entrada);
        const o4 = a.createOscillator(); o4.type = 'triangle'; o4.frequency.value = 208; o4.start(t); o4.stop(t + 0.13);
        const gg4 = ganho(0.1); o4.connect(gg4); gg4.connect(entrada);
        const s5 = ruido(t + 0.011, 0.05, 1); const b5 = filtro('bandpass', 3400, 7); const gg5 = ganho(0.2);
        s5.connect(b5); b5.connect(gg5); gg5.connect(entrada);
        const s6 = ruido(t + 0.002, 0.03, 1.2); const h6 = filtro('highpass', 4200, 0.9); const gg6 = ganho(0.2);
        s6.connect(h6); h6.connect(gg6); gg6.connect(entrada);
      }
    }
    const t = performance.now();
    await a.startRendering();
    return +(((performance.now() - t) / 1000) / DUR).toFixed(3);
  };

  const med = async (K, modo) => {
    const v = [await mede(K, modo), await mede(K, modo), await mede(K, modo)];
    return v.sort((x, y) => x - y)[1];
  };

  const MODOS = ['orfa', 'simples', 'sem-envio', 'tiro', 'tiro-HRTF', 'tiro-cache'];
  const linhas = [];
  for (const K of KS) {
    const l = { K };
    for (const m of MODOS) l[m] = await med(K, m);
    linhas.push(l);
  }
  return { linhas, MODOS };
}, KS);

console.log('\nCUSTO DE DSP — carga = parede / audio   (>=1.0 impossivel em tempo real; >0.35 zona de risco)\n');
console.log(' vozes |    orfa | simples | sem-envio | tiro (ANTES) | tiro-HRTF | tiro-cache (DEPOIS) | ganho');
console.log('-'.repeat(100));
for (const l of r.linhas) {
  const g = l['tiro-cache'] > 0 ? (l['tiro'] / l['tiro-cache']).toFixed(1) + 'x' : '-';
  console.log(`${String(l.K).padStart(6)} | ${String(l['orfa']).padStart(7)} | ${String(l['simples']).padStart(7)} | ` +
    `${String(l['sem-envio']).padStart(9)} | ${String(l['tiro']).padStart(12)} | ${String(l['tiro-HRTF']).padStart(9)} | ` +
    `${String(l['tiro-cache']).padStart(19)} | ${String(g).padStart(5)}`);
}
await b.close(); vite.kill();
