/** Mede a regeneracao de vida: atraso ate comecar e tempo ate encher. */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const ROOT = process.cwd(), PORT = Number(process.env.PORT ?? 5273);
const vite = spawn(process.execPath, [ROOT+'/node_modules/vite/bin/vite.js','--config','tools/vite.diag.config.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'], {cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{const t=setTimeout(()=>j(new Error('t/o')),60000);vite.stdout.on('data',d=>{if(/ready in|Local:/i.test(String(d))){clearTimeout(t);r();}});});
const b = await chromium.launch({headless:true, executablePath:process.env.PW_CHROME||undefined, args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio']});
const p = await b.newPage({viewport:{width:1280,height:720}});
await p.goto(`http://127.0.0.1:${PORT}/`, {waitUntil:'load', timeout:120000});
await p.waitForFunction(()=>window.__game?.ready, undefined, {timeout:240000});
await p.waitForTimeout(1200);
const r = await p.evaluate(() => {
  const ctx = window.__game.ctx, jog = ctx.player;
  ctx.state = 'jogando';
  jog.alive = true; jog.health = 1; jog._sinceDamage = 0;
  const dt = 1/60;
  let tComecou = null, tCheio = null, tt = 0;
  for (let i = 0; i < 60 * 40; i++) {
    const antes = jog.health;
    jog._regenerar ? jog._regenerar(dt) : jog.update(dt);
    tt += dt;
    if (tComecou === null && jog.health > antes + 1e-6) tComecou = tt;
    if (tCheio === null && jog.health >= jog.maxHealth) { tCheio = tt; break; }
  }
  return { tComecou, tCheio, cura: tCheio && tComecou ? tCheio - tComecou : null };
});
console.log(`atraso ate comecar : ${r.tComecou?.toFixed(2)} s`);
console.log(`tempo ate encher   : ${r.cura?.toFixed(2)} s  (de 1 a 100)`);
console.log(`total              : ${r.tCheio?.toFixed(2)} s`);
await b.close(); vite.kill();
