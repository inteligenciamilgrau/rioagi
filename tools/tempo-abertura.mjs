/**
 * Mede a linha do tempo da abertura: quando a arte aparece, quando a tela de
 * carregamento assume, quando o menu assenta — e quanto custou cada PNG.
 *
 * Uso: node tools/tempo-abertura.mjs [larguraxaltura]
 * Precisa do vite de pé em 127.0.0.1:5173.
 */
import { chromium } from 'playwright';

const [W, H] = (process.argv[2] || '1280x720').split('x').map(Number);

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: W, height: H } });
p.setDefaultTimeout(300000);
p.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));

// Carimba o instante de cada marco a partir do próprio relógio da página.
await p.addInitScript(() => {
  window.__t = {};
  const marca = (n) => { if (!window.__t[n]) window.__t[n] = Math.round(performance.now()); };
  const olhar = () => {
    if (document.querySelector('#pre-carga .arte-foto.pronta')) marca('artePreCarga');
    if (document.querySelector('#tela-carga .arte-foto.pronta')) marca('arteCarga');
    if (document.querySelector('#tela-carga.ativa')) marca('cargaAtiva');
    if (document.querySelector('#tela-menu.ativa')) marca('menuAtivo');
    if (!document.getElementById('pre-carga')) marca('preCargaRemovida');
    if (!window.__t.menuAtivo) requestAnimationFrame(olhar);
  };
  addEventListener('DOMContentLoaded', olhar, { once: true });
});

await p.goto('http://127.0.0.1:5173/', { waitUntil: 'commit', timeout: 60000 });
await p.waitForFunction(() => window.__t?.menuAtivo, null, { timeout: 300000 });
await p.waitForTimeout(2400);

const m = await p.evaluate(() => ({
  marcas: window.__t,
  imgs: performance.getEntriesByType('resource')
    .filter((r) => /\/capa\//.test(r.name))
    .map((r) => ({
      arquivo: r.name.split('/').pop(),
      inicio: Math.round(r.startTime),
      fim: Math.round(r.responseEnd),
      ms: Math.round(r.duration),
      kb: Math.round((r.transferSize || r.encodedBodySize || 0) / 1024),
    })),
}));

console.log(`viewport ${W}x${H}`);
console.log('marcas (ms desde o início da página):');
for (const [k, v] of Object.entries(m.marcas)) console.log(`  ${k.padEnd(18)} ${v} ms`);
console.log('imagens da capa:');
for (const i of m.imgs) console.log(`  ${i.arquivo.padEnd(18)} ${i.kb} KB  ${i.inicio}→${i.fim} ms (${i.ms} ms)`);
await b.close();
