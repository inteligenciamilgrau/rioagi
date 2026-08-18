/**
 * Verifica a tela do TAB: mapa 2D + inventario.
 *
 * Inclui a prova que mais importa: hostil ATRAS DE PAREDE nao pode aparecer no
 * mapa. Sem essa checagem o TAB viraria raio-x sem ninguem perceber.
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 5275);

const vite = spawn(process.execPath, [
  ROOT + '/node_modules/vite/bin/vite.js',
  '--config', 'tools/vite.diag.config.js',
  '--host', '127.0.0.1', '--port', String(PORT), '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r, j) => {
  const t = setTimeout(() => j(new Error('timeout vite')), 60000);
  vite.stdout.on('data', (d) => { if (/ready in|Local:/i.test(String(d))) { clearTimeout(t); r(); } });
});

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PW_CHROME || undefined,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERR:', String(e).split('\n')[0]));
await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready, undefined, { timeout: 240000 });
await page.waitForTimeout(1500);

let falhas = 0;
const checa = (n, ok, d = '') => {
  console.log((ok ? '  OK  ' : ' FALHA') + '  ' + n + (d ? '   ' + d : ''));
  if (!ok) falhas++;
};

const r = await page.evaluate(async () => {
  const ctx = window.__game.ctx;
  const hud = ctx.hud;
  const mo = ctx.mochila;
  ctx.state = 'jogando';
  ctx.menu?.mostrar?.(null);
  hud.setVisible(true);

  // Mochila com conteudo, jogador ferido: o E deve mirar no kit.
  mo.reset();
  mo.guardar('kit'); mo.guardar('kit'); mo.guardar('municao');
  ctx.player.health = 45;

  const seg = (v) => { ctx.input.keys[v ? 'add' : 'delete']('Tab'); };

  seg(false);
  for (let i = 0; i < 6; i++) hud.update(1 / 60);
  const fechado = document.querySelector('.hud-mapao').classList.contains('aberto');

  seg(true);
  for (let i = 0; i < 20; i++) hud.update(1 / 60);
  const cv = document.querySelector('.hud-mapao canvas');
  const itens = [...document.querySelectorAll('.inv-item')].map((el) => ({
    tipo: el.dataset.tipo,
    alvo: el.classList.contains('alvo'),
    vazio: el.classList.contains('vazio'),
    qtd: el.querySelector('.qtd')?.textContent,
  }));

  const aberto = {
    visivel: document.querySelector('.hud-mapao').classList.contains('aberto'),
    canvasPintado: cv.width > 100 && cv.height > 100,
    pos: document.querySelector('.rodape-mapao .pos')?.textContent,
    host: document.querySelector('.rodape-mapao .host')?.textContent,
    nota: document.querySelector('.inv-nota')?.textContent,
    itens,
  };

  seg(false);
  for (let i = 0; i < 6; i++) hud.update(1 / 60);
  const fechouDeNovo = !document.querySelector('.hud-mapao').classList.contains('aberto');

  return { fechado, aberto, fechouDeNovo };
});

console.log('');
console.log('=== abrir e fechar com TAB ===');
checa('comeca fechado', r.fechado === false);
checa('TAB segurado abre', r.aberto.visivel === true);
checa('o canvas tem tamanho real', r.aberto.canvasPintado === true);
checa('soltar TAB fecha', r.fechouDeNovo === true);

console.log('');
console.log('=== rodape ===');
checa('mostra a coordenada X/Y/Z', /X .*Y .*Z /.test(r.aberto.pos || ''), r.aberto.pos);
checa('conta hostis a vista', /HOSTI/.test(r.aberto.host || ''), r.aberto.host);

console.log('');
console.log('=== inventario ===');
checa('lista os tres tipos', r.aberto.itens.length === 3, r.aberto.itens.map((i) => i.tipo).join(', '));
const kit = r.aberto.itens.find((i) => i.tipo === 'kit');
const sup = r.aberto.itens.find((i) => i.tipo === 'suprimento');
checa('kit mostra 2 de 3', (kit?.qtd || '').replace(/\s/g, '') === '2/3', kit?.qtd);
checa('kit marcado como alvo do E (ferido)', kit?.alvo === true);
checa('suprimento vazio fica apagado', sup?.vazio === true);
checa('a nota diz o que o E usa', /E usa/.test(r.aberto.nota || ''), r.aberto.nota);

// --- o mapa nao pode ser raio-x ---
const visao = await page.evaluate(() => {
  const ctx = window.__game.ctx;
  const mp = ctx.hud.mapao;
  const jog = ctx.player;
  const olho = jog.eyePosition;
  const yaw = jog.rig?.yaw ?? 0;
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);

  /* Falso inimigo a 2 m na frente. Perto de proposito: a 8 m havia parede no
   * caminho e o teste passava com ZERO dos dois lados — comparar 0 com 0 nao
   * prova nada, e o recurso podia estar totalmente quebrado sem acusar. */
  const perto = { pos: { x: olho.x + fx * 2, y: jog.position.y, z: olho.z + fz * 2 }, morto: false, ativo: true, alive: true };
  // Outro bem longe, na direcao oposta — nunca pode aparecer.
  const atras = { pos: { x: olho.x - fx * 2, y: jog.position.y, z: olho.z - fz * 2 }, morto: false, ativo: true, alive: true };

  /* Trocar `ai.pool` NAO funciona: `_hostisVisiveis` le `ai.getEnemies()`, que
   * devolve `this.vivos.filter(e => e.alive)` e nunca olha para o pool. A
   * primeira versao deste teste caiu nessa e mediu zero dos dois lados —
   * passando por comparar 0 com 0. Aqui trocamos o proprio metodo. */
  const original = ctx.ai.getEnemies;
  const medir = (lista) => {
    ctx.ai.getEnemies = () => lista;
    const out = [];
    mp._hostisVisiveis(out);
    return out.length;
  };
  const soFrente = medir([perto]);
  const soAtras = medir([atras]);
  const ambos = medir([perto, atras]);
  ctx.ai.getEnemies = original;
  return { soFrente, soAtras, ambos };
});

console.log('');
console.log('=== o mapa nao e raio-x ===');
checa('hostil NA FRENTE aparece', visao.soFrente === 1, String(visao.soFrente));
checa('hostil ATRAS nao aparece', visao.soAtras === 0, String(visao.soAtras));
checa('um na frente e um atras: aparece exatamente 1', visao.ambos === 1, visao.ambos + ' de 2');

await page.evaluate(() => {
  const ctx = window.__game.ctx;
  ctx.input.keys.add('Tab');
  for (let i = 0; i < 20; i++) ctx.hud.update(1 / 60);
});
await page.waitForTimeout(300);
await page.screenshot({ path: ROOT + '/shots/tab-mapa-inventario.png' });

await browser.close();
vite.kill();
console.log('');
console.log(falhas === 0 ? '>>> OK' : '>>> ' + falhas + ' FALHA(S)');
process.exit(falhas === 0 ? 0 : 1);
