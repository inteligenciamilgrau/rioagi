/**
 * atlasfolha.mjs — fotografa o atlas de folha (albedo, alfa e normal) para
 * julgar a textura ANTES de olhar para o mapa. Se a silhueta nao presta aqui,
 * nao vai prestar em lugar nenhum.
 *
 * Saida: shots/folha-atlas.png
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const ROOT = process.cwd();
const PORT = process.env.PORT || 5173;
mkdirSync(ROOT + '/shots', { recursive: true });

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 1580, height: 560 } });
p.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));
p.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE:', m.text().slice(0, 200)); });

await p.goto(`http://127.0.0.1:${PORT}/test/materials.html`, { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(1500);

const info = await p.evaluate(async () => {
  const { TextureLab } = await import('/src/world/materials/TextureLab.js');
  const { gerarFolha } = await import('/src/world/materials/generators/folhagem.js');
  const lab = new TextureLab({ renderer: null, anisotropy: 8, assincrono: false });
  await lab.prepararBanco(256);
  const t0 = performance.now();
  const d = await gerarFolha(lab, { w: 512, h: 512, semente: 5309 });
  const ms = Math.round(performance.now() - t0);

  const N = 512;
  const mk = (fn) => {
    const c = document.createElement('canvas'); c.width = c.height = N;
    const g = c.getContext('2d');
    const img = g.createImageData(N, N);
    fn(img.data);
    g.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  };
  // 1) albedo sobre xadrez (o alfa aparece como buraco)
  const albedo = mk((o) => {
    for (let i = 0; i < N * N; i++) {
      const x = i % N, y = (i / N) | 0;
      const xad = (((x >> 4) + (y >> 4)) & 1) ? 210 : 120;
      const a = d.albedo[i * 4 + 3] / 255;
      o[i * 4] = d.albedo[i * 4] * a + xad * (1 - a);
      o[i * 4 + 1] = d.albedo[i * 4 + 1] * a + xad * (1 - a);
      o[i * 4 + 2] = d.albedo[i * 4 + 2] * a + xad * (1 - a);
      o[i * 4 + 3] = 255;
    }
  });
  // 2) alfa puro, ja com o corte de alphaTest 0.42 aplicado
  const alfa = mk((o) => {
    for (let i = 0; i < N * N; i++) {
      const v = d.albedo[i * 4 + 3] / 255 >= 0.42 ? 255 : 0;
      o[i * 4] = o[i * 4 + 1] = o[i * 4 + 2] = v; o[i * 4 + 3] = 255;
    }
  });
  // 3) height (vira o normal por Sobel)
  const alt = mk((o) => {
    for (let i = 0; i < N * N; i++) {
      const v = d.altura[i] * 255;
      o[i * 4] = o[i * 4 + 1] = o[i * 4 + 2] = v; o[i * 4 + 3] = 255;
    }
  });

  // cobertura de alfa por celula (para prever o comportamento no mip)
  const cob = [];
  for (let k = 0; k < 16; k++) {
    const ci = k % 4, cj = (k / 4) | 0;
    let s = 0, t = 0;
    for (let y = cj * 128; y < (cj + 1) * 128; y++) {
      for (let x = ci * 128; x < (ci + 1) * 128; x++) {
        s += d.albedo[(y * N + x) * 4 + 3] / 255; t++;
      }
    }
    cob.push(+(s / t).toFixed(2));
  }
  return { albedo, alfa, alt, ms, cob };
});

console.log(`gerarFolha 512x512 em ${info.ms} ms`);
console.log('cobertura de alfa por celula:', info.cob.join(' '));

const m = await b.newPage({ viewport: { width: 1580, height: 560 } });
await m.setContent(`<style>body{margin:0;background:#181818;font:13px monospace;color:#ddd;display:flex;gap:8px;padding:8px}
figure{margin:0}img{display:block;width:512px;image-rendering:pixelated}figcaption{padding:4px}</style>
<figure><img src="${info.albedo}"><figcaption>albedo x alfa (xadrez = vazado)</figcaption></figure>
<figure><img src="${info.alfa}"><figcaption>alfa apos alphaTest 0.42</figcaption></figure>
<figure><img src="${info.alt}"><figcaption>height (fonte do normal)</figcaption></figure>`);
await m.screenshot({ path: `${ROOT}/shots/folha-atlas.png` });
console.log('-> shots/folha-atlas.png');
await b.close();
