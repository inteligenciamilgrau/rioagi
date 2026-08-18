/**
 * portashot.mjs — capturas do conserto de "nao da para sair".
 *
 *   1. porta-fechada.png  — porta de casa, fechada, com a DICA na tela
 *   2. porta-aberta.png   — a mesma porta depois do KeyF
 *   3. porta-dentro.png   — de dentro da casa, olhando a porta aberta e a rua
 *   4. descida-antes.png / descida-depois.png — telhado que so tinha salto
 *
 * Duas armadilhas do harness, ja pagas:
 *  · `page.waitForFunction(fn, {timeout})` IGNORA o timeout — a assinatura e
 *    `(fn, arg, options)`.
 *  · a primeira carga do Vite otimiza dependencia e RECARREGA a pagina no meio;
 *    por isso ha uma pagina de aquecimento descartada.
 *  · gravar em `shots/` acorda o watcher — usamos `tools/vite.diag.config.js`,
 *    que ignora essa pasta.
 *
 *   node tools/portashot.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 5239);

const vite = spawn(process.execPath, [
  ROOT + '/node_modules/vite/bin/vite.js', '--config', ROOT + '/tools/vite.diag.config.js',
  '--host', '127.0.0.1', '--port', String(PORT), '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r, j) => {
  let o = ''; const h = (d) => { o += d; if (/ready in/.test(o)) r(); };
  vite.stdout.on('data', h); vite.stderr.on('data', h);
  setTimeout(() => j(new Error('timeout vite')), 60000);
});

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});

async function aguardar(pg) {
  await pg.waitForFunction(() => window.__game?.ready, null, { timeout: 300000 });
  await pg.waitForFunction(() => window.__game?.ctx?.menu?.telaAtual === 'menu', null, { timeout: 180000 });
  await pg.waitForTimeout(700);
}

/* Aquecimento: a primeira carga recarrega sozinha e leva `window.__game` junto. */
{
  const q = await b.newPage({ viewport: { width: 800, height: 600 } });
  await q.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
  await aguardar(q);
  await q.close();
}

const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await aguardar(p);

/** Tira o menu da frente e liga o HUD — o caminho que funciona (ver NOTES). */
await p.evaluate(() => {
  const ctx = window.__game.ctx;
  ctx.menu?.mostrar?.(null);
  ctx.state = 'jogando';
  ctx.hud?.reset?.();
  ctx.hud?.setVisible?.(true);
});
await p.waitForTimeout(300);

/**
 * Poe o jogador de pe olhando para um alvo, e roda o `update` do Player para o
 * jogo inteiro (mira, dica de acao, HUD) ficar coerente com a pose.
 */
async function posar(olho, alvo, quadros = 40) {
  return p.evaluate(({ olho, alvo, quadros }) => {
    const ctx = window.__game.ctx;
    const pl = ctx.player;
    pl.movement.teleport(olho[0], olho[1] - 1.68, olho[2]);
    pl.movement.velocity.set(0, 0, 0);
    const dx = alvo[0] - olho[0], dy = alvo[1] - olho[1], dz = alvo[2] - olho[2];
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(dy, Math.hypot(dx, dz));
    pl.rig.reset(yaw, pitch);
    for (let i = 0; i < quadros; i++) {
      pl.update(1 / 60);
      ctx.world.update(1 / 60, 0);
      ctx.hud.update(1 / 60);
    }
    window.__game.settle(12);
    return {
      pos: [+pl.position.x.toFixed(2), +pl.position.y.toFixed(2), +pl.position.z.toFixed(2)],
      dica: document.querySelector('.hud-acao')?.className,
      texto: document.querySelector('.hud-acao .rot')?.textContent,
    };
  }, { olho, alvo, quadros });
}

/* ---------------------------------------------------------------- porta */
const cena = await p.evaluate(() => {
  const w = window.__game.ctx.world;
  /* Escolhe a porta com mais espaco livre na frente: e a que rende foto legivel
   * (beco de 1,3 m enquadra parede, nao porta). */
  let melhor = null, melhorD = -1;
  for (const q of w.portas.lista) {
    const cx = q.eixo.x + Math.cos(q.yawBase) * q.w * 0.5;
    const cz = q.eixo.z - Math.sin(q.yawBase) * q.w * 0.5;
    const o = { x: cx + q.nx * 0.2, y: q.eixo.y + 1.5, z: cz + q.nz * 0.2 };
    const V = w.group.position.constructor;
    const h = w.collision.raycast(new V(o.x, o.y, o.z), new V(q.nx, 0, q.nz), 12);
    const d = h.hit ? h.distance : 12;
    if (d > melhorD) { melhorD = d; melhor = { q, cx, cz, d }; }
  }
  if (!melhor) return null;
  const { q, cx, cz, d } = melhor;
  const rec = Math.min(3.0, Math.max(1.9, d - 0.6));
  return {
    livre: +d.toFixed(2),
    fora: [cx + q.nx * rec, q.eixo.y + 1.68, cz + q.nz * rec],
    dentro: [cx - q.nx * 1.7, q.eixo.y + 1.68, cz - q.nz * 1.7],
    alvo: [cx, q.eixo.y + 1.15, cz],
    casa: [+q.casa.x.toFixed(1), +q.casa.z.toFixed(1)],
  };
});
console.log('porta escolhida:', JSON.stringify(cena));

if (cena) {
  // 1) fechada, com a dica na tela
  let r = await posar(cena.fora, cena.alvo);
  console.log('  fechada:', JSON.stringify(r));
  await p.screenshot({ path: `${ROOT}/shots/porta-fechada.png` });

  // 2) aberta (mesma pose, mesma camera — a unica coisa que muda e a folha)
  await p.evaluate(() => {
    const ctx = window.__game.ctx;
    const pl = ctx.player;
    ctx.world.portas.acionar(pl._acaoAlvo);
    for (let i = 0; i < 60; i++) { ctx.world.update(1 / 60, 0); pl.update(1 / 60); ctx.hud.update(1 / 60); }
    window.__game.settle(12);
  });
  await p.waitForTimeout(200);
  await p.screenshot({ path: `${ROOT}/shots/porta-aberta.png` });

  // 3) de dentro para fora
  r = await posar(cena.dentro, cena.alvo);
  console.log('  de dentro:', JSON.stringify(r));
  await p.screenshot({ path: `${ROOT}/shots/porta-dentro.png` });
}

/* --------------------------------------------------------------- descida */
const tel = await p.evaluate(() => {
  const w = window.__game.ctx.world;
  const V = w.group.position.constructor;
  // casa que GANHOU degraus de fuga: procura laje com degrau logo ao lado
  const casas = w.favela.casas.filter((c) => typeof c.telhadoY === 'number');
  let melhor = null;
  for (const c of casas) {
    if (c.telhadoY - c.baseY < 4.5) continue;              // queria queda visivel
    const co = Math.cos(c.yaw), si = Math.sin(c.yaw);
    for (const [lx, lz] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const nx = lx * co + lz * si, nz = -lx * si + lz * co;
      const half = (lx === 0 ? c.d : c.w) * 0.5;
      const px = c.x + nx * (half + 1.1), pz = c.z + nz * (half + 1.1);
      // ha superficie de concreto entre o telhado e o chao neste ponto?
      const h = w.collision.raycast(new V(px, c.telhadoY - 0.4, pz), new V(0, -1, 0), 6);
      if (!h.hit) continue;
      const alturaDeg = h.point.y;
      const solo = w.terrain.heightAt(px, pz);
      if (alturaDeg - solo < 1.6) continue;
      if (c.telhadoY - alturaDeg > 2.6) continue;
      melhor = {
        casa: [+c.x.toFixed(1), +c.z.toFixed(1)],
        telhadoY: +c.telhadoY.toFixed(2), degrauY: +alturaDeg.toFixed(2), solo: +solo.toFixed(2),
        // camera de fora, na altura do degrau, olhando a parede
        olho: [px + nx * 6.5, alturaDeg + 2.2, pz + nz * 6.5],
        alvo: [px, alturaDeg - 0.2, pz],
      };
      break;
    }
    if (melhor) break;
  }
  return melhor;
});
console.log('descida escolhida:', JSON.stringify(tel));

if (tel) {
  await p.evaluate(({ olho, alvo }) => {
    window.__game.poseAerea(olho, alvo, { hideViewmodel: true });
    window.__game.settle(16);
  }, tel);
  await p.waitForTimeout(200);
  await p.screenshot({ path: `${ROOT}/shots/descida-degraus.png` });

  // vista de cima da laje, olhando a propria descida
  await p.evaluate(({ casa, telhadoY, degrauY }) => {
    const w = window.__game.ctx.world;
    const c = w.favela.casas.find((k) => Math.abs(k.x - casa[0]) < 0.2 && Math.abs(k.z - casa[1]) < 0.2);
    void c; void telhadoY; void degrauY;
  }, tel);
}

await b.close();
vite.kill();
console.log('\ncapturas em shots/: porta-fechada.png, porta-aberta.png, porta-dentro.png, descida-degraus.png');
