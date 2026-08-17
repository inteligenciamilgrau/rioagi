/** Sonda: o Chrome deste ambiente expoe AudioContext.renderCapacity? */
import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage();
await p.goto('about:blank');
const r = await p.evaluate(async () => {
  const a = new AudioContext();
  const out = {
    temRenderCapacity: !!a.renderCapacity,
    props: a.renderCapacity ? Object.getOwnPropertyNames(Object.getPrototypeOf(a.renderCapacity)) : null,
    baseLatency: a.baseLatency, outputLatency: a.outputLatency, sr: a.sampleRate, state: a.state,
    temWorklet: !!a.audioWorklet,
  };
  if (a.renderCapacity) {
    const eventos = [];
    a.renderCapacity.onupdate = (e) => eventos.push({
      t: +e.timestamp.toFixed(2), avg: +e.averageLoad.toFixed(3),
      peak: +e.peakLoad.toFixed(3), under: +e.underrunRatio.toFixed(3),
    });
    a.renderCapacity.start({ updateInterval: 0.5 });
    // carga: monte convolvers grandes para ver a metrica reagir
    await new Promise(r => setTimeout(r, 2500));
    out.eventos = eventos;
  }
  return out;
});
console.log(JSON.stringify(r, null, 2));
await b.close();
