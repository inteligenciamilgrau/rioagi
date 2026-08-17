/**
 * Prova visual da maquina DENTRO do jogo, em luz de dia — a unica captura que
 * vale como aceite.  Gera, com nomes novos (nunca sobrescreve a linha de base):
 *
 *   shots/robov2-sol-3vars.png     as tres variantes lado a lado, em pleno sol
 *   shots/robov2-sol-5m.png        uma maquina a  5 m, em pleno sol
 *   shots/robov2-sol-15m.png       uma maquina a 15 m, em pleno sol  <- a fenda
 *   shots/robov2-sol-30m.png       uma maquina a 30 m, em pleno sol
 *   shots/robov2-cabeca.png        a cabeca de perto, de dia
 *   shots/robov2-nove.png          nove maquinas (mesmo enquadramento do antigo)
 *   shots/robov2-sombra-3vars.png  as tres em sombra aberta
 *
 * E imprime fps com 9 maquinas contra a cena vazia, no mesmo protocolo de
 * tools/roboJogo.mjs, para poder comparar sem regressao.
 *
 *   node tools/roboProva.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const ROOT = process.cwd(), PORT = 5202;
const vite = spawn(process.execPath, [
  ROOT + '/node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT),
  '--strictPort', '--config', ROOT + '/tools/vite.diag.config.js',
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
p.setDefaultTimeout(300000);
p.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));
p.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text().slice(0, 160)); });
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__game?.ready, { timeout: 240000 });
await p.waitForTimeout(1500);

/* ---------------------------------------------------- acha os dois palcos */
const palcos = await p.evaluate(() => {
  const ctx = window.__game.ctx;
  ctx.state = 'pausado';
  ctx.ai.spawnAutomatico = false;
  ctx.menu?.hideAll?.(); ctx.hud?.setVisible?.(false); ctx.viewScene.visible = false;
  ctx.lighting.update = () => {}; ctx.sky.update = () => {};
  for (const e of ctx.ai.pool) { e.ativo = false; e.soldado.grupo.visible = false; }
  ctx.ai.vivos.length = 0;

  const T = ctx.camera.position.constructor;
  const sol = ctx.lighting.sunDirection.clone();
  const col = ctx.world.collision;
  const pts = ctx.world.getSpawnPoints();
  const noSol = (x, y, z) => !col.raycast(new T(x, y + 1.2, z), sol, 90)?.hit;
  const chao = (x, z, yRef) => {
    const r = col.raycast(new T(x, yRef + 4, z), new T(0, -1, 0), 12);
    return r?.hit ? r.point.y : null;
  };
  /**
   * @param {boolean} querSol alvo em pleno sol (true) ou em sombra (false)
   * @param {number}  lado    +1 = sol nas COSTAS da camera (maquina de frente
   *                          para o sol, contraluz na camera = nao);
   *                          -1 = camera contra o sol (maquina em contraluz);
   *                          0  = tanto faz
   */
  const procurar = (querSol, lado = 0) => {
    for (let i = 0; i < pts.length; i++) {
      const q = pts[i].position ?? pts[i];
      for (let g = 0; g < 24; g++) {
        const yaw = (g / 24) * Math.PI * 2;
        const dx = Math.sin(yaw), dz = -Math.cos(yaw);
        // dx,dz = direcao da camera para a maquina. Se ela apontar CONTRA o
        // sol, a maquina fica em contraluz e so a franja acende; se apontar a
        // favor, o sol bate na cara dela — que e a foto que prova a cor.
        if (lado) {
          const alinhado = dx * sol.x + dz * sol.z;   // >0 = olhando para o sol
          if (lado > 0 && alinhado > -0.55) continue; // sol atras da camera
          if (lado < 0 && alinhado < 0.55) continue;  // sol de frente
        }
        let ok = true; const alvos = [];
        for (const d of [5, 15, 30]) {
          const x = q.x + dx * d, z = q.z + dz * d;
          const y = chao(x, z, q.y);
          if (y === null || Math.abs(y - q.y) > 3.0) { ok = false; break; }
          if (noSol(x, y, z) !== querSol) { ok = false; break; }
          alvos.push({ d, x, y, z });
        }
        if (!ok) continue;
        const olho = new T(q.x, q.y + 1.68, q.z);
        const a30 = alvos[2];
        const dir = new T(a30.x - olho.x, (a30.y + 1.0) - olho.y, a30.z - olho.z);
        const dist = dir.length(); dir.normalize();
        if (col.raycast(olho, dir, dist - 0.7)?.hit) continue;
        return { spawn: i, yaw, base: { x: q.x, y: q.y, z: q.z }, alvos };
      }
    }
    return null;
  };
  window.__pal = {
    sol: procurar(true, 1) || procurar(true, 0),   // sol na cara da maquina
    contraluz: procurar(true, -1) || procurar(true, 0),
    sombra: procurar(false, 0),
  };
  return Object.fromEntries(Object.entries(window.__pal).map(([k, v]) => [k, !!v]));
});
console.log('palcos:', JSON.stringify(palcos));

const tira = async (nome, fn, arg) => {
  if (fn) await p.evaluate(fn, arg);
  // O menu e DOM por cima do canvas e volta sozinho: tem de ser escondido a
  // CADA foto, como faz tools/roboJogo.mjs. Sem isto a captura sai da capa.
  await p.evaluate(() => {
    const c = window.__game.ctx;
    c.menu?.hideAll?.(); c.hud?.setVisible?.(false); c.viewScene.visible = false;
    window.__game.settle(26);
  });
  await p.waitForTimeout(120);
  await p.screenshot({ path: `${ROOT}/shots/${nome}.png` });
  console.log('  ->', nome);
};

/** Coloca N maquinas numa fila perpendicular a linha de visada. */
const POR = `
window.__por = (palco, dist, quais, espaco) => {
  const ctx = window.__game.ctx;
  const T = ctx.camera.position.constructor;
  const pl = window.__pal[palco];
  const olho = new T(pl.base.x, pl.base.y + 1.68, pl.base.z);
  const dx = Math.sin(pl.yaw), dz = -Math.cos(pl.yaw);
  const px = -dz, pz = dx;                      // perpendicular no plano
  for (const e of ctx.ai.pool) e.soldado.grupo.visible = false;
  const centro = { x: pl.base.x + dx * dist, y: 0, z: pl.base.z + dz * dist };
  const yBase = (pl.alvos.find((a) => a.d === dist) || pl.alvos[0]).y;
  quais.forEach((v, i) => {
    const S = ctx.ai.pool.find((e) => e.soldado.variante === v).soldado;
    const off = (i - (quais.length - 1) / 2) * espaco;
    const x = centro.x + px * off, z = centro.z + pz * off;
    const r = ctx.world.collision.raycast(new T(x, yBase + 3, z), new T(0, -1, 0), 10);
    const y = r?.hit ? r.point.y : yBase;
    S.reviver();
    S.grupo.visible = true;
    S.grupo.position.set(x, y, z);
    S.grupo.rotation.set(0, Math.atan2(olho.x - x, olho.z - z), 0);
    S.setLocomocao(0, 0, false); S.setMira(olho, 1); S.setPoseArma('mira');
    for (let k = 0; k < 50; k++) S.update(1 / 60);
  });
  ctx.camera.up.set(0, 1, 0);
  ctx.camera.position.copy(olho);
  ctx.camera.lookAt(centro.x, yBase + 1.15, centro.z);
  ctx.camera.updateMatrixWorld(true);
};`;
await p.evaluate(POR);

await tira('robov2-sol-3vars', () => window.__por('sol', 5.2, [0, 1, 2], 1.5));
await tira('robov2-sol-15m', () => window.__por('sol', 15, [0, 1, 2], 1.6));
await tira('robov2-sol-30m', () => window.__por('sol', 30, [0, 1, 2], 1.8));
await tira('robov2-contraluz-3vars', () => window.__por('contraluz', 5.2, [0, 1, 2], 1.5));
await tira('robov2-contraluz-15m', () => window.__por('contraluz', 15, [0, 1, 2], 1.6));
await tira('robov2-sombra-3vars', () => window.__por('sombra', 5.2, [0, 1, 2], 1.5));
await tira('robov2-cabeca', () => {
  const ctx = window.__game.ctx;
  window.__por('sol', 5, [1], 0);
  const S = ctx.ai.pool.find((e) => e.soldado.variante === 1).soldado;
  const olho = S.posOlho().clone();
  ctx.camera.position.set(olho.x + 0.10, olho.y + 0.05, olho.z + 0.85);
  ctx.camera.lookAt(olho.x, olho.y - 0.01, olho.z);
  ctx.camera.updateMatrixWorld(true);
});

/* ------------------------------------------------- nove maquinas + fps ---
 * Mesmo protocolo de tools/roboJogo.mjs, para o numero ser comparavel. */
await p.evaluate(() => {
  const ctx = window.__game.ctx;
  // devolve o ceu/luz ao normal antes do teste de carga
  delete ctx.lighting.update; delete ctx.sky.update;
  for (const e of ctx.ai.pool) { e.ativo = false; e.soldado.grupo.visible = false; }
  ctx.ai.vivos.length = 0;
});

const base = await p.evaluate(() => {
  const ctx = window.__game.ctx;
  ctx.state = 'jogando';
  for (let i = 0; i < 30; i++) window.__game.settle(1);
  const t0 = performance.now();
  for (let i = 0; i < 90; i++) window.__game.settle(1);
  return { ms: (performance.now() - t0) / 90 };
});
console.log('  referencia (cena sem maquinas):', (1000 / base.ms).toFixed(1), 'fps ·', base.ms.toFixed(2), 'ms/quadro');

const fps = await p.evaluate(() => {
  const ctx = window.__game.ctx;
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
  for (let i = 0; i < 30; i++) window.__game.settle(1);
  const t0 = performance.now();
  const N = 90;
  for (let i = 0; i < N; i++) window.__game.settle(1);
  const dt = performance.now() - t0;
  const info = ctx.renderer.info.render;
  return {
    ms: dt / N, fps: 1000 / (dt / N), triangulos: info.triangles, draws: info.calls,
    vivos: ctx.ai.pool.filter((e) => e.ativo && !e.morto).length,
    programas: ctx.renderer.info.programs?.length ?? 0,
  };
});
console.log('  fps com 9 maquinas:', JSON.stringify(fps));
await p.evaluate(() => {
  const ctx = window.__game.ctx;
  ctx.state = 'pausado';
  ctx.menu?.hideAll?.(); ctx.hud?.setVisible?.(false); ctx.viewScene.visible = false;
});
await tira('robov2-nove');

console.log('ok');
await b.close();
vite.kill();
