/**
 * Prova que segurar TAB nao vaza para a navegacao por foco do navegador.
 *
 * O bug: `onKeyDown` fazia `if (e.repeat) return;` ANTES do `preventDefault`,
 * entao so o primeiro evento era barrado. Tecla segurada repete, e cada
 * repeticao escapava — o foco saia passeando pela pagina.
 *
 * Por isso o teste manda REPETICOES, nao um toque so: com um unico keydown o
 * bug antigo passaria despercebido.
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 5277);

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
await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready, undefined, { timeout: 240000 });
await page.waitForTimeout(1500);

let falhas = 0;
const checa = (n, ok, d = '') => {
  console.log((ok ? '  OK  ' : ' FALHA') + '  ' + n + (d ? '   ' + d : ''));
  if (!ok) falhas++;
};

const r = await page.evaluate(() => {
  const ctx = window.__game.ctx;
  ctx.state = 'jogando';
  ctx.menu?.mostrar?.(null);

  const disparar = (repeat) => {
    const ev = new KeyboardEvent('keydown', {
      code: 'Tab', key: 'Tab', repeat, bubbles: true, cancelable: true,
    });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  };

  // 1 toque + 8 repeticoes, que e o que acontece ao SEGURAR a tecla.
  const primeiro = disparar(false);
  const repeticoes = [];
  for (let i = 0; i < 8; i++) repeticoes.push(disparar(true));

  // O foco tambem nao pode ter andado.
  const focoAntes = document.activeElement?.tagName;

  return {
    primeiro,
    repeticoes,
    todasBarradas: repeticoes.every(Boolean),
    quantasVazaram: repeticoes.filter((v) => !v).length,
    foco: focoAntes,
  };
});

console.log('');
console.log('=== segurar TAB (1 toque + 8 repeticoes) ===');
checa('o primeiro keydown e barrado', r.primeiro === true);
checa('TODAS as repeticoes sao barradas', r.todasBarradas === true,
  r.quantasVazaram + ' de 8 vazaram');
checa('o foco nao foi para um controle', r.foco === 'BODY' || r.foco === 'CANVAS', String(r.foco));

// Sem pointer lock o Tab tambem tem de ser barrado: o lock pode cair sozinho.
const semLock = await page.evaluate(() => {
  const ctx = window.__game.ctx;
  ctx.input.locked = false;
  const ev = new KeyboardEvent('keydown', { code: 'Tab', key: 'Tab', repeat: true, bubbles: true, cancelable: true });
  window.dispatchEvent(ev);
  return ev.defaultPrevented;
});
console.log('');
console.log('=== sem pointer lock ===');
checa('TAB continua barrado', semLock === true);

/* Controle: uma tecla que NAO pertence a ninguem deve continuar livre sem
 * lock. F5 nao serve — o Etiquetas.js usa para identificar objeto na mira e
 * barra de proposito (F3/F4/F5/F6 sao todas de depuracao). F7 esta livre. */
const controle = await page.evaluate(() => {
  const ctx = window.__game.ctx;
  ctx.input.locked = false;
  const ev = new KeyboardEvent('keydown', { code: 'F7', key: 'F7', repeat: false, bubbles: true, cancelable: true });
  window.dispatchEvent(ev);
  return ev.defaultPrevented;
});
console.log('');
console.log('=== controle: nao sequestramos o navegador a toa ===');
checa('F7 sem lock NAO e barrado', controle === false, 'defaultPrevented=' + controle);

await browser.close();
vite.kill();
console.log('');
console.log(falhas === 0 ? '>>> OK' : '>>> ' + falhas + ' FALHA(S)');
process.exit(falhas === 0 ? 0 : 1);
