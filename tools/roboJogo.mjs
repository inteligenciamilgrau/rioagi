/**
 * Prova do robo DENTRO do jogo: luz e ceu de verdade, PostFX (bloom) ligado,
 * ragdoll de verdade e medicao de fps com 8+ maquinas em cena.
 *
 *   node tools/roboJogo.mjs
 *
 * Sai em shots/robo-jogo-*.png.  Copiado do padrao de tools/verinimigo.mjs.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const ROOT = process.cwd(), PORT = 5198;
const vite = spawn(process.execPath, [
  ROOT + '/node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort', '--config', ROOT + '/tools/vite.diag.config.js',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r, j) => {
  let o = ''; const h = (d) => { o += d; if (/ready in/.test(o)) r(); };
  vite.stdout.on('data', h); vite.stderr.on('data', h);
  setTimeout(() => j(new Error('timeout do vite')), 40000);
});

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 1000, height: 720 } });
p.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));
p.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text().slice(0, 160)); });

await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__game?.ready, { timeout: 180000 });
await p.waitForTimeout(1500);

const tira = async (nome, fn) => {
  if (fn) await p.evaluate(fn);
  await p.evaluate(() => {
    const c = window.__game.ctx;
    c.menu?.hideAll?.(); c.hud?.setVisible?.(false); c.viewScene.visible = false;
    window.__game.settle(14);
  });
  await p.waitForTimeout(200);
  await p.screenshot({ path: `${ROOT}/shots/${nome}.png` });
  console.log('  ->', nome);
};

// ------------------------------------------------------ um robo, de perto
await tira('robo-jogo-1-perto', () => {
  const ctx = window.__game.ctx; ctx.state = 'pausado';
  ctx.ai.spawnAutomatico = false;
  const pts = ctx.world.getSpawnPoints(); const sp = pts[9]; const P = sp.position ?? sp;
  window.__P = P;
  const e = ctx.ai.spawn(P, 0, null); window.__e = e;
  ctx.camera.up.set(0, 1, 0);
  ctx.camera.position.set(P.x, P.y + 1.35, P.z + 3.0);
  ctx.camera.rotation.set(0, 0, 0, 'YXZ');
  ctx.camera.updateMatrixWorld(true);
  e.percepcao.consciencia = 1; e.percepcao.visivel = true; e._trocar('atirar');
  for (let i = 0; i < 40; i++) ctx.ai.update(1 / 60);
});

await tira('robo-jogo-2-cabeca', () => {
  const ctx = window.__game.ctx; const e = window.__e;
  for (let i = 0; i < 20; i++) ctx.ai.update(1 / 60);
  // enquadra a CABECA de verdade (o inimigo anda; o ponto de spawn nao serve)
  const olho = e.soldado.posOlho().clone();
  ctx.camera.position.set(olho.x + 0.10, olho.y + 0.06, olho.z + 0.95);
  ctx.camera.lookAt(olho.x, olho.y - 0.01, olho.z);
  ctx.camera.updateMatrixWorld(true);
});

/* ------------------------------------------------------ maquina abatida
 * Feito AGORA, com a cena ainda em 'pausado' e o pool intacto: depois do teste
 * de carga as maquinas ja mataram o jogador e o AIManager esvazia o pool. */
const mortos = await p.evaluate(() => {
  const ctx = window.__game.ctx;
  const e = window.__e;
  e.levarDano(500, e.pos.clone(), 'torso', { x: 0, y: 0, z: -1 });
  for (let i = 0; i < 42; i++) ctx.ai.update(1 / 60);
  const q = e.soldado.porNome.quadril; q.updateWorldMatrix(true, false);
  const pos = { x: q.matrixWorld.elements[12], y: q.matrixWorld.elements[13], z: q.matrixWorld.elements[14] };
  ctx.camera.position.set(pos.x + 1.3, pos.y + 1.1, pos.z + 1.9);
  ctx.camera.lookAt(pos.x, pos.y, pos.z);
  ctx.camera.updateMatrixWorld(true);
  return { morto: e.morto, vis: e.soldado.grupo.visible, rag: !!e.ragdoll, y: +pos.y.toFixed(2) };
});
console.log('  corpo:', JSON.stringify(mortos));
await tira('robo-jogo-3-abatido');

// ---------------------------------------------------- referencia sem robos
const base = await p.evaluate(() => {
  const ctx = window.__game.ctx;
  ctx.state = 'jogando';
  for (const e of ctx.ai.pool) if (e.ativo) e.despawn?.() ?? (e.ativo = false, e.soldado.grupo.visible = false);
  for (let i = 0; i < 30; i++) window.__game.settle(1);
  const t0 = performance.now();
  for (let i = 0; i < 90; i++) window.__game.settle(1);
  return { ms: (performance.now() - t0) / 90 };
});
console.log('  referencia (cena sem maquinas):', (1000 / base.ms).toFixed(1), 'fps ·', base.ms.toFixed(2), 'ms/quadro');

// ------------------------------------------------------------ nove em cena
const fps = await p.evaluate(async () => {
  const ctx = window.__game.ctx;
  // Em 'jogando' quem manda na camera e o CameraRig: as maquinas tem de nascer
  // na FRENTE do jogador, senao a foto sai da rua vazia.
  ctx.state = 'jogando';
  const jog = ctx.player.position;
  const dir = ctx.camera.getWorldDirection(new ctx.camera.position.constructor());
  for (let i = 0; i < 9; i++) {
    const a = ((i - 4) / 9) * 1.6;
    const d = 4.5 + (i % 3) * 2.2;
    const c = Math.cos(a), s = Math.sin(a);
    const dx = dir.x * c - dir.z * s, dz = dir.x * s + dir.z * c;
    const P = { x: jog.x + dx * d, y: jog.y, z: jog.z + dz * d };
    const e = ctx.ai.spawn(P, Math.PI, null);
    if (!e) continue;
    e.percepcao.consciencia = 1; e.percepcao.visivel = true; e._trocar('atirar');
  }
  // aquece
  for (let i = 0; i < 30; i++) { window.__game.settle(1); }
  const t0 = performance.now();
  const N = 90;
  for (let i = 0; i < N; i++) window.__game.settle(1);
  const dt = performance.now() - t0;
  const info = ctx.renderer.info.render;
  return {
    quadros: N, ms: dt / N, fps: 1000 / (dt / N),
    triangulos: info.triangles, draws: info.calls,
    vivos: ctx.ai.pool.filter((e) => e.ativo && !e.morto).length,
  };
});
console.log('  fps com 9 maquinas em cena:', JSON.stringify(fps));
await tira('robo-jogo-4-nove');

// Isola o custo de DESENHAR a malha nova: mesma IA rodando, malha escondida.
const semMalha = await p.evaluate(() => {
  const ctx = window.__game.ctx;
  const vis = [];
  for (const e of ctx.ai.pool) if (e.ativo) { vis.push(e); e.soldado.grupo.visible = false; }
  for (let i = 0; i < 20; i++) window.__game.settle(1);
  const t0 = performance.now();
  for (let i = 0; i < 90; i++) window.__game.settle(1);
  const ms = (performance.now() - t0) / 90;
  for (const e of vis) e.soldado.grupo.visible = true;
  return { ms, n: vis.length };
});
console.log(`  mesma IA com a malha escondida: ${(1000 / semMalha.ms).toFixed(1)} fps · ${semMalha.ms.toFixed(2)} ms`
  + `  =>  desenhar ${semMalha.n} robos custa ${(fps.ms - semMalha.ms).toFixed(2)} ms/quadro`);

console.log('ok');
await b.close();
vite.kill();
