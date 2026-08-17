/**
 * audiotimbre.mjs — o cache mudou o SOM?
 *
 * A correcao de performance so vale se o timbre continuar o mesmo. Aqui o mesmo
 * disparo e renderizado offline pelos dois caminhos — camada a camada (ao vivo)
 * e pelo buffer do cache — e comparamos pico, energia (RMS) e centroide
 * espectral. Se as tres baterem, o cache e transparente.
 *
 * Tambem confere que a API publica inteira continua respondendo e que o pool
 * nao vaza vozes ao longo de uma rajada.
 *
 * Uso: node tools/audiotimbre.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const ROOT = process.cwd(), PORT = 5235;
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
const erros = [];
p.on('pageerror', e => erros.push(e.message.split('\n')[0]));
p.on('console', m => { if (m.type() === 'error') erros.push(m.text().split('\n')[0]); });
await p.goto(`http://127.0.0.1:${PORT}/tools/audiolab.html`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__lab, { timeout: 30000 });

const r2 = await p.evaluate(async () => {
  const { AudioEngine } = await import('/src/fx/AudioEngine.js');
  const ctxFalso = { settings: { masterVolume: 0.8, sfxVolume: 1, musicVolume: 0 }, bus: null, camera: null, world: null };
  const eng = new AudioEngine(ctxFalso);
  await eng.init();
  Object.defineProperty(eng, 'ativo', { get: () => true });

  const espera = (ms) => new Promise(r => setTimeout(r, ms));
  const medida = (buf) => {
    const d = buf.getChannelData(0);
    let pico = 0, soma = 0, num = 0, den = 0;
    for (let i = 0; i < d.length; i++) { const x = Math.abs(d[i]); if (x > pico) pico = x; soma += d[i] * d[i]; }
    for (let i = 1; i < d.length; i++) { num += Math.abs(d[i] - d[i - 1]); den += Math.abs(d[i]); }
    return { pico: +pico.toFixed(4), rms: +Math.sqrt(soma / d.length).toFixed(5), brilho: +(den > 0 ? num / den : 0).toFixed(3) };
  };
  const mediana = (a, k) => { const v = a.map(x => x[k]).sort((x, y) => x - y); return +v[v.length >> 1].toFixed(5); };

  const SR = eng.actx.sampleRate;
  /** Renderiza offline um som montado por `monta` (mesma receita do motor). */
  const render = async (dur, canais, monta) => {
    const oc = new OfflineAudioContext(canais, Math.ceil(dur * SR), SR);
    const eu = Object.create(eng);
    eu.actx = oc;
    eu.bufRuido = eng._criaRuido.call(eu, Math.max(0.6, dur + 0.2), canais);
    eu._vozAtual = null;
    const alvo = oc.createGain(); alvo.connect(oc.destination);
    monta.call(eu, alvo, 0.002);
    return await oc.startRendering();
  };

  const out = [];
  for (const arma of ['fuzil', 'pistola', 'escopeta', 'smg', 'padrao']) {
    // 1) referencia: camadas ao vivo, 7 sorteios
    const vivo = [];
    for (let i = 0; i < 7; i++) {
      vivo.push(medida(await render(0.6, 1, function (alvo, td) {
        this._camadasTiro(alvo, td, this._receita(arma), false);
      })));
    }
    // 2) o que o cache guardou: forca o pre-render e le os buffers
    eng._bufs.delete(`tiro:${arma}:l`);
    eng._preRenderiza(`tiro:${arma}:l`, 0.6, 1, function (alvo, td) {
      this._camadasTiro(alvo, td, this._receita(arma), false);
    });
    for (let i = 0; i < 60 && !eng._bufs.has(`tiro:${arma}:l`); i++) await espera(50);
    const bufs = eng._bufs.get(`tiro:${arma}:l`) || [];
    const cache = bufs.map(medida);
    out.push({
      arma,
      vivo: { pico: mediana(vivo, 'pico'), rms: mediana(vivo, 'rms'), brilho: mediana(vivo, 'brilho') },
      cache: cache.length ? { pico: mediana(cache, 'pico'), rms: mediana(cache, 'rms'), brilho: mediana(cache, 'brilho') } : null,
    });
  }

  // --- API publica inteira responde? e o pool devolve as vozes? -----------
  const api = ['tiro', 'impacto', 'passo', 'recarga', 'grito', 'cartucho',
    'danoJogador', 'zumbido', 'aterrissagem', 'cliqueSeco'];
  const faltando = api.filter(m => typeof eng[m] !== 'function');
  const chamadas = [];
  try {
    eng.tiro('fuzil', null, true); eng.impacto('metal', null); eng.passo('concreto', null, true);
    eng.recarga('magin'); eng.grito(null, 'dor'); eng.cartucho(null, 1);
    eng.danoJogador(0.5); eng.zumbido(0.5); eng.aterrissagem(6, 'concreto'); eng.cliqueSeco();
  } catch (e) { chamadas.push(String(e.message)); }

  // rajada longa: as vozes voltam para o pool?
  const pico = { vozes: 0 };
  for (let k = 0; k < 120; k++) {
    eng.tiro('fuzil', null, true);
    eng.impacto('concreto', null);
    if (eng.vozes > pico.vozes) pico.vozes = eng.vozes;
    await espera(25);
  }
  await espera(1500);
  eng._reciclaVozes();
  const depois = { vozes: eng.vozes, ...eng.estatisticas() };
  return { out, faltando, chamadas, picoVozes: pico.vozes, depois };
});

console.log('\nTIMBRE — camadas ao vivo vs. o que foi para o cache (mediana)\n');
console.log('arma     |        pico vivo / cache |         rms vivo / cache |     brilho vivo / cache');
console.log('-'.repeat(96));
let ok = true;
for (const o of r2.out) {
  if (!o.cache) { console.log(`${o.arma.padEnd(8)} | CACHE NAO FICOU PRONTO`); ok = false; continue; }
  const d = (a, b2) => (b2 === 0 ? 0 : Math.abs(a - b2) / Math.max(1e-9, b2));
  const bom = d(o.cache.pico, o.vivo.pico) < 0.25 && d(o.cache.rms, o.vivo.rms) < 0.30 && d(o.cache.brilho, o.vivo.brilho) < 0.25;
  if (!bom) ok = false;
  console.log(`${o.arma.padEnd(8)} | ${String(o.vivo.pico).padStart(11)} / ${String(o.cache.pico).padEnd(10)} | ` +
    `${String(o.vivo.rms).padStart(11)} / ${String(o.cache.rms).padEnd(10)} | ` +
    `${String(o.vivo.brilho).padStart(10)} / ${String(o.cache.brilho).padEnd(9)} ${bom ? '' : '  <-- DIVERGE'}`);
}
console.log('\nAPI publica faltando:', r2.faltando.length ? r2.faltando.join(', ') : 'nenhuma');
console.log('erros ao chamar a API:', r2.chamadas.length ? r2.chamadas.join(' | ') : 'nenhum');
console.log('pico de vozes na rajada:', r2.picoVozes);
console.log('depois de 1,5 s parado ->', JSON.stringify(r2.depois));
console.log('\nerros de pagina:', erros.length ? [...new Set(erros)].slice(0, 5).join(' | ') : 'nenhum');
console.log(ok && r2.faltando.length === 0 && erros.length === 0 && r2.depois.vozes === 0
  ? '\n>>> cache transparente, API intacta, pool zerado'
  : '\n>>> VERIFICAR ACIMA');
await b.close(); vite.kill();
