/**
 * Degradação: com a pasta /capa/ inteira fora do ar, a abertura tem de cair no
 * fundo em CSS de styles.css sem quebrar nada e sem erro no console.
 * Uso: node tools/semarte.mjs
 */
import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.setDefaultTimeout(300000);
const erros = [];
p.on('pageerror', (e) => erros.push('PAGEERR: ' + e.message.split('\n')[0]));
p.on('console', (m) => { if (m.type() === 'error') erros.push('CONSOLE: ' + m.text().split('\n')[0]); });
await p.route('**/capa/**', (r) => r.abort());
await p.goto('http://127.0.0.1:5173/', { waitUntil: 'commit', timeout: 60000 });
await p.waitForFunction(() => window.__game?.ready, null, { timeout: 300000 });
await p.waitForFunction(() => document.querySelector('#tela-menu.ativa'), null, { timeout: 300000 });
await p.waitForTimeout(2500);
const r = await p.evaluate(() => ({
  preCarga: !!document.getElementById('pre-carga'),
  temArte: !!document.querySelector('.tela.tem-arte'),
  temLogo: !!document.querySelector('.marca-logo'),
  marcaPausa: !!document.querySelector('.marca-pausa'),
  tituloTexto: document.querySelector('#tela-menu .titulo')?.textContent.trim(),
  fundoCss: !!document.querySelector('#tela-menu .fundo-ceu'),
  fundoVisivel: getComputedStyle(document.querySelector('#tela-menu .fundo-ceu')).display,
  botoes: document.querySelectorAll('#tela-menu .bt').length,
}));
console.log(JSON.stringify(r));
await p.screenshot({ path: process.cwd() + '/shots/abertura-semarte-1280x720.png' });
console.log('erros:', erros.length ? erros.slice(0, 5) : 'nenhum');
await b.close();
