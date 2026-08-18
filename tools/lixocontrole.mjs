/**
 * lixocontrole.mjs — AFERICAO DO INSTRUMENTO de alocacao.
 *
 * Antes de acusar qualquer modulo de "alocar por quadro" e preciso saber o que
 * cada medidor de fato ve. Este script aloca uma quantidade CONHECIDA (~57 MB
 * em 600 quadros) e compara dois instrumentos:
 *
 *   - o amostrador de alocacao do V8 pelo CDP (`HeapProfiler.startSampling`)
 *   - a soma das SUBIDAS de `performance.memory.usedJSHeapSize` quadro a quadro
 *     (o que o `tools/pico.mjs` usa)
 *
 * RESULTADO MEDIDO NESTA MAQUINA (Chrome do Playwright 1.5x):
 *
 *   alocado de verdade   ~57,2 MB
 *   amostrador V8          0,0 MB   <-- NAO SERVE. Erra por mais de 1000x.
 *   soma das subidas      27,6 MB   ·  quedas > 2 MB: 0 em 600 quadros
 *
 * Conclusoes que valem para quem for medir lixo neste projeto:
 *  1. NAO use `HeapProfiler.startSampling` para achar quem aloca aqui — ele
 *     nao enxerga alocacao de vida curta na geracao nova, que e justamente a
 *     que interessa. Uma passada inteira foi gasta assim.
 *  2. A soma das subidas de `performance.memory` e um PISO (subestimou 2x),
 *     nunca um teto. Se ela acusa 650 KB por quadro, e pelo menos isso.
 *  3. Queda de heap maior que 2 MB nao deu um unico falso positivo no
 *     controle: quando o relatorio do `pico.mjs` conta centenas delas, sao
 *     coletas de verdade.
 *
 * Uso: node tools/lixocontrole.mjs
 */
import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, args: ['--enable-precise-memory-info'] });
const p = await b.newPage();
await p.setContent('<body>');
const cdp = await p.context().newCDPSession(p);
await cdp.send('HeapProfiler.enable');
await cdp.send('HeapProfiler.startSampling', { samplingInterval: 4096 });
const r = await p.evaluate(() => new Promise((res) => {
  // 100 KB por "quadro", 600 quadros = 60 MB conhecidos
  const lixo = [];
  let n = 0, somaSubidas = 0, ant = performance.memory.usedJSHeapSize, quedas = 0;
  const passo = () => {
    for (let i = 0; i < 25; i++) lixo.push(new Array(500).fill(0));
    lixo.length = 0;
    const h = performance.memory.usedJSHeapSize;
    const d = h - ant; ant = h;
    if (d > 0) somaSubidas += d; else if (d < -2 * 1024 * 1024) quedas++;
    if (++n < 600) requestAnimationFrame(passo); else res({ somaSubidas, quedas, n });
  };
  requestAnimationFrame(passo);
}));
const { profile } = await cdp.send('HeapProfiler.stopSampling');
let total = 0; const anda = (x) => { total += x.selfSize || 0; (x.children || []).forEach(anda); };
anda(profile.head);
console.log('alocado de verdade  ~', (600 * 25 * 500 * 8 / 1048576).toFixed(1), 'MB (600 quadros x 25 arrays de 500)');
console.log('amostrador V8       ', (total / 1048576).toFixed(1), 'MB');
console.log('soma das subidas de performance.memory', (r.somaSubidas / 1048576).toFixed(1), 'MB  ·  quedas>2MB', r.quedas, ' em', r.n, 'quadros');
await b.close();
