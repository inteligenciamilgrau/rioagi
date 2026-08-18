/**
 * Verifica as duas mudancas:
 *
 *  1. `Player.destravar()` MOVE o jogador e NAO devolve vida nem municao
 *     (diferente de `respawn()`, que zera tudo por ser volta de morte).
 *  2. O viewmodel some quando a luneta assume, e volta ao sair da mira.
 *
 *   node tools/destravar.mjs
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 5252);

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
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__game?.ready, { timeout: 240000 });
await page.waitForTimeout(1200);

let falhas = 0;
const checa = (nome, ok, det = '') => {
  console.log(`${ok ? '  OK  ' : ' FALHA'}  ${nome}${det ? '   ' + det : ''}`);
  if (!ok) falhas++;
};

/* ---------------------------------------------------------------- */
/* 1. destravar()                                                    */
/* ---------------------------------------------------------------- */
const d = await page.evaluate(() => {
  const ctx = window.__game.ctx;
  const p = ctx.player;
  ctx.state = 'jogando';

  // Estado "machucado e gastando bala", que e a situacao em que o abuso
  // apareceria se destravar curasse.
  p.health = 37;
  const slot = p.weapons.slot;
  slot.ammo = 4;
  slot.reserve = 11;
  const antes = {
    vida: p.health, ammo: slot.ammo, reserve: slot.reserve,
    x: +p.movement.position.x.toFixed(2), z: +p.movement.position.z.toFixed(2),
  };

  p.destravar();

  const depois = {
    vida: p.health, ammo: slot.ammo, reserve: slot.reserve,
    x: +p.movement.position.x.toFixed(2), z: +p.movement.position.z.toFixed(2),
    vel: +p.movement.velocity.length().toFixed(3),
    vivo: p.alive,
  };
  const dist = Math.hypot(depois.x - antes.x, depois.z - antes.z);
  return { antes, depois, dist: +dist.toFixed(1), vidaMax: p.maxHealth };
});

console.log('\n=== destravar(): move sem premiar ===');
checa('o jogador saiu do lugar', d.dist > 3, `${d.dist} m`);
checa('vida PRESERVADA (nao curou)', d.depois.vida === d.antes.vida, `${d.antes.vida} -> ${d.depois.vida} (max ${d.vidaMax})`);
checa('municao no pente preservada', d.depois.ammo === d.antes.ammo, `${d.antes.ammo} -> ${d.depois.ammo}`);
checa('reserva preservada', d.depois.reserve === d.antes.reserve, `${d.antes.reserve} -> ${d.depois.reserve}`);
checa('velocidade zerada', d.depois.vel < 0.01, `${d.depois.vel}`);
checa('continua vivo', d.depois.vivo === true);

/* ---------------------------------------------------------------- */
/* 2. viewmodel x luneta                                             */
/* ---------------------------------------------------------------- */
const v = await page.evaluate(async () => {
  const ctx = window.__game.ctx;
  const p = ctx.player;
  const passo = (n) => { for (let i = 0; i < n; i++) p.update(1 / 60); };

  const ler = () => ({ visivel: p.viewModel.root.visible, adsT: +ctx.player.weapons.adsT.toFixed(2) });

  // fuzil comum (slot 0): a arma NUNCA some, mesmo mirando
  p.weapons.switchTo(0); passo(60);
  p.forceADS?.(true); passo(90);
  const fuzilMirando = ler();

  // sniper (slot 1): some quando a optica assume
  p.forceADS?.(false); passo(60);
  p.weapons.switchTo(1); passo(90);
  const sniperQuadril = ler();
  p.forceADS?.(true); passo(90);
  const sniperMirando = ler();
  p.forceADS?.(false); passo(90);
  const sniperVoltou = ler();

  return { fuzilMirando, sniperQuadril, sniperMirando, sniperVoltou };
});

console.log('\n=== viewmodel x luneta ===');
checa('fuzil comum: arma VISIVEL mirando', v.fuzilMirando.visivel === true, `adsT ${v.fuzilMirando.adsT}`);
checa('sniper no quadril: arma VISIVEL', v.sniperQuadril.visivel === true, `adsT ${v.sniperQuadril.adsT}`);
checa('sniper na luneta: arma OCULTA', v.sniperMirando.visivel === false, `adsT ${v.sniperMirando.adsT}`);
checa('sniper saindo da mira: arma VOLTA', v.sniperVoltou.visivel === true, `adsT ${v.sniperVoltou.adsT}`);

await browser.close();
vite.kill();
console.log(falhas === 0 ? '\n>>> OK' : `\n>>> ${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);
