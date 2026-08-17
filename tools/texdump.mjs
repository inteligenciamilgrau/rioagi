/**
 * texdump.mjs — despeja o ALBEDO e a RUGOSIDADE isolados de uma superficie,
 * sem iluminacao nenhuma no meio. E a unica forma honesta de decidir se uma cor
 * errada na tela vem do material ou da luz/tonemap.
 *
 * Saida: shots/tex-<rotulo>-<superficie>.png  (albedo | rugosidade lado a lado)
 *        shots/texdump-<rotulo>.json          (estatistica de cor e rugosidade)
 *
 * Uso: node tools/texdump.mjs <rotulo> [sup1,sup2,...]
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const ROOT = process.cwd();
const PORT = process.env.PORT || 5199;
const ROTULO = process.argv[2] || 'antes';
const SUPS = (process.argv[3] || 'terra,asfalto,calcada_portuguesa,grama,reboco,concreto').split(',');
mkdirSync(ROOT + '/shots', { recursive: true });

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 1200, height: 700 } });
p.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));
await p.route('**/@vite/client', (r) => r.abort());
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__game?.ready, null, { timeout: 300000 });

const stats = await p.evaluate((sups) => {
  const lib = window.__game.ctx.materials;
  const out = {};
  const pct = (arr, q) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(q * (arr.length - 1))))];

  for (const nome of sups) {
    const m = lib.get(nome);
    const alb = m?.map?.image;
    const orm = m?.roughnessMap?.image;
    if (!alb?.data) { out[nome] = { erro: 'sem albedo' }; continue; }
    const d = alb.data, n = d.length / 4;

    let R = 0, G = 0, B = 0;
    const lum = new Float64Array(n);
    let azulados = 0;             // pixels em que B supera R de forma perceptivel
    for (let i = 0, k = 0; i < d.length; i += 4, k++) {
      R += d[i]; G += d[i + 1]; B += d[i + 2];
      lum[k] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      if (d[i + 2] > d[i] + 8) azulados++;
    }
    lum.sort();
    const rec = {
      albedo: {
        media: [Math.round(R / n), Math.round(G / n), Math.round(B / n)],
        // desvio B-R em pontos de 0-255: positivo = frio, negativo = quente
        desvioAzul: +((B - R) / n).toFixed(2),
        fracPixelsAzulados: +(azulados / n).toFixed(3),
        lumP05: Math.round(pct(lum, 0.05)), lumP50: Math.round(pct(lum, 0.50)),
        lumP95: Math.round(pct(lum, 0.95)),
        contraste: Math.round(pct(lum, 0.95) - pct(lum, 0.05)),
      },
      resolucao: alb.width,
      metros: m.userData?.metros,
    };

    if (orm?.data) {
      const o = orm.data, m2 = o.length / 4;
      const rug = new Float64Array(m2);
      let espelhado = 0;          // rugosidade < 0.25 = praticamente espelho
      for (let i = 0, k = 0; i < o.length; i += 4, k++) {
        rug[k] = o[i + 1] / 255;
        if (rug[k] < 0.25) espelhado++;
      }
      rug.sort();
      rec.rugosidade = {
        media: +(rug.reduce((a, c) => a + c, 0) / m2).toFixed(3),
        p05: +pct(rug, 0.05).toFixed(3), p50: +pct(rug, 0.5).toFixed(3), p95: +pct(rug, 0.95).toFixed(3),
        fracEspelhada: +(espelhado / m2).toFixed(3),
      };
    }
    out[nome] = rec;
  }
  return out;
}, SUPS);

console.log(`\n=== ALBEDO ISOLADO (sem luz) — ${ROTULO} ===`);
console.log('superficie            media RGB        B-R    %azul  contraste  rug.med  rug.p05  %espelho');
console.log('-'.repeat(100));
for (const [n, r] of Object.entries(stats)) {
  if (r.erro) { console.log(n.padEnd(22), r.erro); continue; }
  const a = r.albedo, g = r.rugosidade ?? {};
  console.log(
    n.padEnd(22) +
    `(${a.media.join(',')})`.padEnd(17) +
    String(a.desvioAzul).padStart(6) +
    String((a.fracPixelsAzulados * 100).toFixed(1) + '%').padStart(8) +
    String(a.contraste).padStart(11) +
    String(g.media ?? '-').padStart(9) +
    String(g.p05 ?? '-').padStart(9) +
    String(((g.fracEspelhada ?? 0) * 100).toFixed(1) + '%').padStart(10),
  );
}
writeFileSync(`${ROOT}/shots/texdump-${ROTULO}.json`, JSON.stringify(stats, null, 2));

// --- painel visual: albedo puro e rugosidade puros, lado a lado ---
for (const nome of SUPS) {
  const ok = await p.evaluate((n) => {
    const lib = window.__game.ctx.materials;
    const m = lib.get(n);
    const alb = m?.map?.image, orm = m?.roughnessMap?.image;
    if (!alb?.data) return false;
    const faz = (img, canal) => {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const g = c.getContext('2d');
      const id = g.createImageData(img.width, img.height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        if (canal === null) { id.data[i] = d[i]; id.data[i + 1] = d[i + 1]; id.data[i + 2] = d[i + 2]; }
        else { id.data[i] = id.data[i + 1] = id.data[i + 2] = d[i + canal]; }
        id.data[i + 3] = 255;
      }
      g.putImageData(id, 0, 0);
      return c.toDataURL('image/png');
    };
    window.__dump = {
      albedo: faz(alb, null),
      rug: orm?.data ? faz(orm, 1) : null,
      ao: orm?.data ? faz(orm, 0) : null,
      w: alb.width, metros: m.userData?.metros?.[0] ?? 1,
    };
    return true;
  }, nome);
  if (!ok) { console.log(`  (sem ${nome})`); continue; }

  const d = await p.evaluate(() => window.__dump);
  const pg = await b.newPage({ viewport: { width: 1560, height: 560 } });
  await pg.setContent(`<style>body{margin:0;background:#141414;color:#eee;font:13px monospace}
    main{display:flex;gap:8px;padding:8px}figure{margin:0}
    img{display:block;width:500px;height:500px;image-rendering:pixelated}
    figcaption{padding:4px}</style><main>
    <figure><img src="${d.albedo}"><figcaption>${nome} — ALBEDO (${d.w}px / ${d.metros} m)</figcaption></figure>
    ${d.rug ? `<figure><img src="${d.rug}"><figcaption>RUGOSIDADE (preto=espelho, branco=fosco)</figcaption></figure>` : ''}
    ${d.ao ? `<figure><img src="${d.ao}"><figcaption>AO</figcaption></figure>` : ''}
    </main>`);
  await pg.screenshot({ path: `${ROOT}/shots/tex-${ROTULO}-${nome}.png`, fullPage: true });
  await pg.close();
  console.log(`  -> shots/tex-${ROTULO}-${nome}.png`);
}

await b.close();
