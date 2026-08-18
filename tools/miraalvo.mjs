/**
 * Verifica as duas mudancas de interface:
 *
 *  1. A tela de morte trava os botoes por alguns segundos e depois libera.
 *  2. A mira sinaliza hostil na linha de tiro — e NAO sinaliza atras de parede.
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 5278);

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

/* ---------------- 1. trava da tela de morte ---------------- */
const morte = await page.evaluate(async () => {
  const ctx = window.__game.ctx;
  ctx.menu.mostrar('morte');
  const bts = () => [...document.querySelectorAll('#tela-morte .bt')];
  const logo = {
    n: bts().length,
    travados: bts().every((b) => b.disabled),
    comBarra: bts().every((b) => b.classList.contains('travado')),
    // O cursor nao pode aparecer durante a trava: e o que mais quebra o momento.
    telaTravada: document.getElementById('tela-morte')?.classList.contains('travada'),
    cursorEscondido: getComputedStyle(document.getElementById('tela-morte')).cursor === 'none',
  };
  // Tenta clicar durante a trava: nao pode reiniciar.
  const antes = ctx.menu.telaAtual;
  bts()[0]?.click();
  ctx.menu._acao('reiniciar');            // fura o disabled de proposito
  const depoisDoClique = ctx.menu.telaAtual;
  return { logo, aindaNaMorte: depoisDoClique === antes };
});

console.log('');
console.log('=== tela de morte, logo apos cair ===');
checa('ha botoes na tela', morte.logo.n >= 1, morte.logo.n + ' botao(oes)');
checa('todos comecam desabilitados', morte.logo.travados === true);
checa('todos mostram a barra de espera', morte.logo.comBarra === true);
checa('clique/acao durante a trava NAO reinicia', morte.aindaNaMorte === true);
checa('a tela esta marcada como travada', morte.logo.telaTravada === true);
checa('o cursor fica ESCONDIDO', morte.logo.cursorEscondido === true, morte.logo.cursorEscondido ? '' : 'cursor visivel');

// Espera passar a trava (5 s) e confere a liberacao.
await page.waitForTimeout(5600);
const liberou = await page.evaluate(() => {
  const bts = [...document.querySelectorAll('#tela-morte .bt')];
  return {
    habilitados: bts.every((b) => !b.disabled),
    semBarra: bts.every((b) => !b.classList.contains('travado')),
    focado: document.activeElement?.classList?.contains('bt') === true,
    cursorVoltou: getComputedStyle(document.getElementById('tela-morte')).cursor !== 'none',
  };
});
console.log('');
console.log('=== depois da espera ===');
checa('botoes habilitados', liberou.habilitados === true);
checa('barra sumiu', liberou.semBarra === true);
checa('foco foi para o botao', liberou.focado === true);
checa('o cursor volta a aparecer', liberou.cursorVoltou === true);

/* ---------------- 2. mira com alvo ---------------- */
const mira = await page.evaluate(async () => {
  const ctx = window.__game.ctx;
  ctx.menu.mostrar(null);
  ctx.state = 'jogando';
  ctx.player.alive = true;
  ctx.player.health = 100;
  ctx.hud.setVisible(true);

  const cam = ctx.camera;
  const dir = new (cam.getWorldDirection(new (Object.getPrototypeOf(cam.position).constructor)()).constructor)();
  cam.getWorldDirection(dir);

  const ler = () => document.querySelector('.hud-mira')?.classList.contains('no-alvo');

  const originalRay = ctx.ai.raycastEnemies;
  const originalCol = ctx.world.collision.raycast;

  // (a) nenhum hostil
  ctx.ai.raycastEnemies = () => null;
  for (let i = 0; i < 12; i++) ctx.hud.update(1 / 60);
  const semHostil = ler();

  // (b) hostil a 10 m, sem parede
  ctx.ai.raycastEnemies = () => ({ distance: 10, part: 'torso' });
  ctx.world.collision.raycast = () => ({ hit: false });
  for (let i = 0; i < 12; i++) ctx.hud.update(1 / 60);
  const comHostil = ler();

  // (c) hostil a 10 m mas PAREDE a 4 m
  ctx.world.collision.raycast = () => ({ hit: true, distance: 4 });
  for (let i = 0; i < 12; i++) ctx.hud.update(1 / 60);
  const atrasDeParede = ler();

  ctx.ai.raycastEnemies = originalRay;
  ctx.world.collision.raycast = originalCol;
  for (let i = 0; i < 12; i++) ctx.hud.update(1 / 60);
  const voltouAoNormal = ler();

  return { semHostil, comHostil, atrasDeParede, voltouAoNormal };
});

console.log('');
console.log('=== mira sinaliza alvo ===');
checa('sem hostil: mira normal', mira.semHostil === false);
checa('hostil na linha de tiro: mira ACENDE', mira.comHostil === true);
checa('hostil ATRAS DE PAREDE: nao acende', mira.atrasDeParede === false);
checa('volta ao normal quando o alvo sai', mira.voltouAoNormal === false);

await browser.close();
vite.kill();
console.log('');
console.log(falhas === 0 ? '>>> OK' : '>>> ' + falhas + ' FALHA(S)');
process.exit(falhas === 0 ? 0 : 1);
