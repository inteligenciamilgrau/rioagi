/**
 * audioteto.mjs — quanto custa CADA PECA do caminho de voz, no mundo do cache.
 *
 * AVISO, aprendido na marra: esta bancada NAO decide o teto de vozes, apesar do
 * nome. OfflineAudioContext renderiza em blocos grandes, sem prazo e sem
 * disputar a maquina com render 3D, fisica e IA; a thread de audio de verdade
 * trabalha em quanta de 128 amostras com buffer de ~10 ms, onde o custo FIXO por
 * no pesa muito mais. Os numeros daqui deram "56 vozes custam 0.25, folga de
 * 4x"; o jogo real com 56 vozes perdeu ~30% do audio. Um fator de ~6.
 *
 * Serve, e bem, para COMPARAR caminhos entre si (camada a camada x cache,
 * equalpower x HRTF, cadeia parada x tocando), que e o que as colunas mostram.
 * Para escolher teto, use tools/audiovarre.mjs, que mede dentro do jogo.
 *
 * O audiolab.mjs respondeu "quanto custa o jeito antigo x o novo" ate 48 vozes.
 * Esta bancada responde outra pergunta: subindo o numero de cadeias ATIVAS no
 * mundo do cache, a partir de quantas a carga comeca a subir de verdade? E
 * quanto custa fazer TODAS elas binaurais (HRTF) em vez de equalpower?
 *
 * Mesma metrica do audiolab: carga = tempo_de_parede / segundos_renderizados.
 * >= 1.0 e impossivel em tempo real; acima de ~0.35 e zona de risco, porque em
 * tempo real a thread de audio divide a maquina com render 3D, fisica e IA.
 *
 * Modos:
 *   parada-eq / parada-hrtf   K cadeias montadas, NADA tocando -> custo do grafo
 *   cache-eq  / cache-hrtf    K cadeias, cada uma disparando uma forma de onda
 *                             em cache a cada 100 ms (600 rpm) o render inteiro
 *                             === pior caso absoluto: TODA voz em cadencia maxima
 *   real-eq                   cadencia realista: tiro a cada 100 ms em 1/3 das
 *                             vozes, passo a cada 400 ms nas demais
 *
 * A maquina esta disputada por varios agentes: cada ponto e a MEDIANA de 5
 * renders, e o teste roda a lista de K duas vezes (ida e volta) para que uma
 * lentidao passageira nao caia sempre no mesmo K.
 *
 * Uso: node tools/audioteto.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const ROOT = process.cwd(), PORT = 5236;
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

const KS = [0, 16, 24, 32, 48, 64, 80, 96, 128];
const r = await p.evaluate(async (KS) => {
  const { AudioEngine } = await import('/src/fx/AudioEngine.js');
  const proto = AudioEngine.prototype;
  const SR = 48000, DUR = 3;

  /** Forma de onda em cache, gerada pelo proprio codigo de sintese do motor. */
  const preRender = async (dur, monta) => {
    const oc = new OfflineAudioContext(1, Math.ceil(dur * SR), SR);
    const eu = Object.create(proto);
    eu.actx = oc;
    eu.bufRuido = proto._criaRuido.call(eu, dur + 0.2, 1);
    eu._vozAtual = null;
    const alvo = oc.createGain(); alvo.connect(oc.destination);
    monta.call(eu, alvo, 0.002);
    return await oc.startRendering();
  };
  const bufTiro = await preRender(0.6, function (alvo, td) {
    this._camadasTiro(alvo, td, this._receita('fuzil'), false);
  });
  const bufPasso = await preRender(0.45, function (alvo, td) {
    this._camadasPasso(alvo, td, { f: 1500, q: 1.1, dec: 0.075, hp: 260, click: 5200, clickG: 0.35, g: 0.55 }, true);
  });

  const mede = async (K, modo) => {
    const a = new OfflineAudioContext(2, SR * DUR, SR);
    const eu = { actx: a };

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

    const hrtf = /hrtf/.test(modo);
    const entradas = [];
    for (let i = 0; i < K; i++) {
      /* Cadeia igual a do motor DEPOIS desta tarefa: duas entradas A/B (o roubo
       * de voz precisa de uma entrada limpa para o som novo enquanto a antiga
       * desvanece), mixer, passa-baixa, atenuacao, panner e os dois envios. */
      const entA = a.createGain(); entA.gain.value = 0.05;
      const entB = a.createGain(); entB.gain.value = 0;
      const mix = a.createGain();
      entA.connect(mix); entB.connect(mix);
      const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 4000; lp.Q.value = 0.2;
      const at = a.createGain(); at.gain.value = 0.7;
      mix.connect(lp); lp.connect(at);
      const pan = a.createPanner();
      pan.panningModel = hrtf ? 'HRTF' : 'equalpower';
      pan.distanceModel = 'inverse'; pan.refDistance = 2.2; pan.rolloffFactor = 1.15; pan.maxDistance = 260;
      const ang = i * 0.7, d = 5 + (i % 20);
      pan.positionX.value = Math.cos(ang) * d; pan.positionZ.value = Math.sin(ang) * d;
      at.connect(pan); pan.connect(busSfx);
      const g1 = a.createGain(); g1.gain.value = 0.4; pan.connect(g1); g1.connect(envioRua);
      const g2 = a.createGain(); g2.gain.value = 0.3; pan.connect(g2); g2.connect(envioBeco);
      entradas.push(entA);
    }

    const dispara = (ent, buf, t) => {
      const s = a.createBufferSource(); s.buffer = buf;
      s.playbackRate.value = 0.97 + Math.random() * 0.06;
      s.connect(ent); s.start(t);
    };
    if (modo.startsWith('cache')) {
      for (let i = 0; i < K; i++) for (let t = 0; t < DUR; t += 0.1) dispara(entradas[i], bufTiro, t);
    } else if (modo.startsWith('real')) {
      for (let i = 0; i < K; i++) {
        if (i % 3 === 0) for (let t = 0; t < DUR; t += 0.1) dispara(entradas[i], bufTiro, t);
        else for (let t = i * 0.01; t < DUR; t += 0.4) dispara(entradas[i], bufPasso, t);
      }
    }
    const t = performance.now();
    await a.startRendering();
    return ((performance.now() - t) / 1000) / DUR;
  };

  const MODOS = ['parada-eq', 'parada-hrtf', 'cache-eq', 'cache-hrtf', 'real-eq'];
  const amostras = {};
  const chave = (K, m) => K + '|' + m;
  // duas passagens em ordens opostas: contencao passageira nao vicia sempre o
  // mesmo K
  for (const passe of [0, 1]) {
    const ordem = passe ? [...KS].reverse() : KS;
    for (const K of ordem) {
      for (const m of MODOS) {
        for (let i = 0; i < 3; i++) {
          (amostras[chave(K, m)] ||= []).push(await mede(K, m));
        }
      }
    }
  }
  const linhas = [];
  for (const K of KS) {
    const l = { K };
    for (const m of MODOS) {
      const v = amostras[chave(K, m)].sort((x, y) => x - y);
      l[m] = +v[v.length >> 1].toFixed(3);
    }
    linhas.push(l);
  }
  return { linhas, MODOS };
}, KS);

console.log('\nTETO DE VOZES — carga = parede / audio  (>=1.0 impossivel; >0.35 zona de risco)');
console.log('mediana de 6 renders por celula\n');
console.log(' vozes | parada-eq | parada-hrtf | cache-eq | cache-hrtf | real-eq | custo HRTF');
console.log('-'.repeat(88));
for (const l of r.linhas) {
  const dh = (l['cache-hrtf'] - l['cache-eq']).toFixed(3);
  console.log(`${String(l.K).padStart(6)} | ${String(l['parada-eq']).padStart(9)} | ${String(l['parada-hrtf']).padStart(11)} | ` +
    `${String(l['cache-eq']).padStart(8)} | ${String(l['cache-hrtf']).padStart(10)} | ${String(l['real-eq']).padStart(7)} | ${String('+' + dh).padStart(10)}`);
}
console.log('\ncusto marginal por voz (cache-eq), entre K consecutivos:');
for (let i = 1; i < r.linhas.length; i++) {
  const a = r.linhas[i - 1], b2 = r.linhas[i];
  console.log(`   ${String(a.K).padStart(3)} -> ${String(b2.K).padEnd(3)}  ${(((b2['cache-eq'] - a['cache-eq']) / (b2.K - a.K)) * 1000).toFixed(2)} milesimos de carga por voz`);
}
await b.close(); vite.kill();
