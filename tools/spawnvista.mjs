/**
 * spawnvista.mjs — o que o jogador VE no primeiro frame ao nascer.
 *
 * Para cada spawn renderiza duas fotos pelo pipeline real (Movement + CameraRig
 * + ViewModel), mudando so o yaw inicial:
 *   -antigo.png = atan2(-p.x,-p.z), o que o codigo fazia (aponta 180° errado)
 *   -novo.png   = Player._rumoInicial(p), o criterio de leque de raycasts
 *
 * Uso: node tools/spawnvista.mjs [indices separados por virgula]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const ROOT = process.cwd();
const PORT = process.env.PORT || 5173;
const IDX = (process.argv[2] ?? '0,1,5,9,17,31,44').split(',').map(Number);
mkdirSync(ROOT + '/shots', { recursive: true });

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 960, height: 540 } });
p.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));
// Outro agente pode estar salvando arquivos: sem o cliente de HMR a pagina nao
// recarrega no meio da sessao de fotos.
await p.route('**/@vite/client', (r) => r.abort());
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__game?.ready, { timeout: 180000 });
await p.waitForTimeout(2000);

// O jogo em si fica parado: quem avanca o Player somos nos, frame a frame.
await p.evaluate(() => { window.__game.ctx.state = 'pausado'; });

const posar = async (idx, modo) => {
  const info = await p.evaluate(([i, m]) => {
    const ctx = window.__game.ctx;
    const pts = ctx.world.getSpawnPoints();
    const s = pts[i % pts.length];
    const q = s.position ?? s;
    const yaw = m === 'novo' ? ctx.player._rumoInicial(q) : Math.atan2(-q.x, -q.z);
    ctx.player.movement.teleport(q.x, q.y + 0.1, q.z);
    ctx.player.rig.reset(yaw, 0);
    // primeiro segundo de jogo, parado: e literalmente o que ele ve ao nascer
    for (let k = 0; k < 60; k++) ctx.player.update(1 / 60);
    const d = ctx.player.rig.aimDir;
    const h = ctx.world.collision.raycast(ctx.player.eyePosition, d, 200);
    return {
      pos: [+q.x.toFixed(1), +q.z.toFixed(1)],
      yaw: +(yaw * 180 / Math.PI).toFixed(0),
      frente: h.hit ? +h.distance.toFixed(1) : null,
    };
  }, [idx, modo]);
  // o menu volta sozinho ~420 ms depois do boot:done — esconder na ultima hora
  await p.evaluate(() => {
    const ctx = window.__game.ctx;
    ctx.menu?.hideAll?.(); ctx.hud?.setVisible?.(false);
    // ele reaparece por timer, entao a raiz da UI sai do caminho de vez
    const ui = document.getElementById('ui-root');
    if (ui) ui.style.display = 'none';
    window.__game.settle(16);
  });
  await p.screenshot({ path: `${ROOT}/shots/spawn-${idx}-${modo}.png` });
  return info;
};

for (const i of IDX) {
  const a = await posar(i, 'antigo');
  const n = await posar(i, 'novo');
  console.log(`spawn ${String(i).padStart(2)} @(${n.pos[0]},${n.pos[1]})  `
    + `antigo yaw=${String(a.yaw).padStart(5)}° parede a ${a.frente ?? 'ceu'} m   |   `
    + `novo yaw=${String(n.yaw).padStart(5)}° parede a ${n.frente ?? 'ceu'} m`);
}
await b.close();
