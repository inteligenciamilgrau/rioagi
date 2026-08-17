/**
 * Prova que o build funciona servido de uma SUBPASTA, que e como o GitHub
 * Pages serve um repositorio comum (https://usuario.github.io/nome-do-repo/).
 *
 * Sobe um servidor estatico onde dist/ mora em /operacao-rio-agi/ e carrega a
 * pagina, anotando todo request que falhar e todo erro de console.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

// resolve() normaliza as barras: sem isto, RAIZ vem com '/' e path.join devolve
// '\' no Windows, e o startsWith de seguranca reprova todo caminho valido.
const RAIZ = path.resolve(process.argv[2]);
// argv[4] permite rodar o CONTROLE na raiz ('' = sem prefixo). Sem um controle
// nao da para saber se uma falha e da subpasta ou do jogo em qualquer lugar.
const PREFIXO = process.argv[4] !== undefined ? process.argv[4] : '/operacao-rio-agi';
const PORTA = 4399;

const TIPOS = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.json': 'application/json',
};

const servidor = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (!url.startsWith(PREFIXO)) { res.writeHead(404); return res.end('fora do prefixo'); }
  let rel = url.slice(PREFIXO.length) || '/';
  if (rel.endsWith('/')) rel += 'index.html';
  const arq = path.join(RAIZ, rel);
  if (!arq.startsWith(RAIZ) || !fs.existsSync(arq) || fs.statSync(arq).isDirectory()) {
    res.writeHead(404); return res.end('nao achei');
  }
  const tipo = TIPOS[path.extname(arq)] ?? 'application/octet-stream';
  const tam = fs.statSync(arq).size;

  /* Range e obrigatorio para <audio>: o elemento pede pedaco por pedaco e
   * ABORTA a conexao se o servidor responder 200 com o arquivo inteiro. Sem
   * isto, mp3 valido aparece como net::ERR_ABORTED e parece defeito do build.
   * O GitHub Pages suporta Range; o servidor de teste precisa suportar tambem,
   * senao a prova nao vale. */
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const ini = m[1] ? parseInt(m[1], 10) : 0;
    const fim = m[2] ? parseInt(m[2], 10) : tam - 1;
    res.writeHead(206, {
      'content-type': tipo,
      'content-range': `bytes ${ini}-${fim}/${tam}`,
      'accept-ranges': 'bytes',
      'content-length': fim - ini + 1,
    });
    return fs.createReadStream(arq, { start: ini, end: fim }).pipe(res);
  }
  res.writeHead(200, { 'content-type': tipo, 'accept-ranges': 'bytes', 'content-length': tam });
  fs.createReadStream(arq).pipe(res);
});
await new Promise((r) => servidor.listen(PORTA, '127.0.0.1', r));

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PW_CHROME || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const falhas = [], erros = [];
page.on('requestfailed', (r) => falhas.push(`${r.failure()?.errorText} ${r.url()}`));
page.on('response', (r) => { if (r.status() >= 400) falhas.push(`HTTP ${r.status()} ${r.url()}`); });
page.on('pageerror', (e) => erros.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') erros.push(`[console] ${m.text()}`); });

const alvo = `http://127.0.0.1:${PORTA}${PREFIXO}/`;
console.log('carregando', alvo);
await page.goto(alvo, { waitUntil: 'load', timeout: 120000 });
// espera o boot andar: o menu so nasce perto do fim
await page.waitForTimeout(45000);

const estado = await page.evaluate(() => ({
  canvas: !!document.querySelector('canvas'),
  arte: [...document.images].filter((i) => i.src.includes('capa'))
    .map((i) => ({ src: i.src.split('/').slice(-1)[0], ok: i.complete && i.naturalWidth > 0 })),
  pronto: !!window.__game?.ready,
}));

console.log('\n=== estado ===');
console.log('canvas:', estado.canvas, '| boot pronto:', estado.pronto);
console.log('imagens de capa:', JSON.stringify(estado.arte));
/* ERR_ABORTED em mp3 NAO e defeito: o Musica.js cria os <audio> no boot, o
 * navegador busca os metadados e aborta o resto porque nada toca sem gesto do
 * usuario. Verificado com controle — acontece identico servindo na raiz, entao
 * nao tem relacao com o caminho. O que importa aqui e 404 e erro de pagina. */
const benignas = falhas.filter((f) => f.startsWith('net::ERR_ABORTED') && f.includes('.mp3'));
const reais = falhas.filter((f) => !benignas.includes(f));

console.log('\n=== requests com falha REAL (' + reais.length + ') ===');
reais.slice(0, 20).forEach((f) => console.log(' ', f));
console.log('\n=== abortos benignos de midia (' + benignas.length + ', esperado 5) ===');
console.log('\n=== erros de pagina (' + erros.length + ') ===');
erros.slice(0, 15).forEach((e) => console.log(' ', e));

await page.screenshot({ path: process.argv[3] ?? 'subpasta.png' });
await browser.close();
servidor.close();
const ok = reais.length === 0 && erros.length === 0 && estado.canvas && estado.pronto
  && estado.arte.length > 0 && estado.arte.every((a) => a.ok);
console.log(ok ? '\n>>> OK: build funciona servido de subpasta' : '\n>>> FALHOU');
process.exit(ok ? 0 : 1);
