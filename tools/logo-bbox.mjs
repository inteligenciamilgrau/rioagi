/**
 * Sonda do logotipo: mede, dentro de `capa_titulo.webp`, a caixa util (alfa > 0)
 * e a caixa do bloco ciano aceso no pingo do "i".
 *
 * Serve para posicionar em CSS o brilho que acende por ultimo sem chutar
 * porcentagem. Roda com o vite de pe na 5173.
 */
import { chromium } from 'playwright';

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' });

const r = await p.evaluate(async () => {
  const img = new Image();
  img.src = '/capa/capa_titulo.webp';
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;

  const caixa = () => ({ x0: 1e9, y0: 1e9, x1: -1, y1: -1, n: 0 });
  const por = (cx, x, y) => { cx.x0 = Math.min(cx.x0, x); cx.y0 = Math.min(cx.y0, y); cx.x1 = Math.max(cx.x1, x); cx.y1 = Math.max(cx.y1, y); cx.n++; };

  const alfa = caixa();
  const ciano = caixa();
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      const a = d[i + 3];
      if (a > 24) por(alfa, x, y);
      const [R, G, B] = [d[i], d[i + 1], d[i + 2]];
      // ciano aceso: azul e verde altos, vermelho baixo
      if (a > 128 && B > 150 && G > 140 && R < G - 60 && R < B - 60) por(ciano, x, y);
    }
  }
  const pct = (cx) => cx.x1 < 0 ? null : {
    px: [cx.x0, cx.y0, cx.x1, cx.y1],
    esq: +(cx.x0 / c.width * 100).toFixed(2),
    dir: +((c.width - cx.x1) / c.width * 100).toFixed(2),
    topo: +(cx.y0 / c.height * 100).toFixed(2),
    base: +((c.height - cx.y1) / c.height * 100).toFixed(2),
    larg: +((cx.x1 - cx.x0) / c.width * 100).toFixed(2),
    alt: +((cx.y1 - cx.y0) / c.height * 100).toFixed(2),
    n: cx.n,
  };
  return { w: c.width, h: c.height, alfa: pct(alfa), ciano: pct(ciano) };
});
console.log(JSON.stringify(r, null, 2));
await b.close();
