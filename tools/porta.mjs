/**
 * porta.mjs — diagnostico de UM vao de porta, milimetro a milimetro.
 *
 * Anda com a capsula do jogador ao longo do eixo da porta, de dentro para fora,
 * e diz em que ponto ela e barrada e por quem (parede do BVH ou folha movel).
 * Serve para separar "o vao nao existe na colisao" de "o vao existe e algo
 * dentro dele atrapalha".
 *
 *   node tools/porta.mjs [indiceDaCasa]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 5233);
const CASA = process.argv[2] ? Number(process.argv[2]) : null;

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
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
p.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__game?.ready, null, { timeout: 300000 });
await p.waitForTimeout(1000);

const r = await p.evaluate((alvoCasa) => {
  const ctx = window.__game.ctx;
  const world = ctx.world;
  const col = world.collision;
  const proto = world.group.position.constructor;
  const v3 = (x = 0, y = 0, z = 0) => new proto(x, y, z);
  const RAIO = 0.35, ALT = 1.80;

  const casas = world.favela.casas;
  const escolhidas = alvoCasa !== null ? [casas[alvoCasa]] : casas.filter((c) => c.interior).slice(0, 4);
  const out = [];

  for (const c of escolhidas) {
    if (!c) continue;
    const portas = world.portas.lista.filter((q) => q.casa === c);
    const anc = world.buildings.ancoras.portas.filter((q) => q.casa === c);
    const linhas = [];
    for (const a of anc) {
      const amostras = [];
      for (let t = -1.6; t <= 1.6001; t += 0.1) {
        const x = a.x + a.nx * t, z = a.z + a.nz * t;
        /* O raio parte da ALTURA DA PORTA, nao de cima da casa: comecando
         * acima do telhado ele bate na laje do teto e reporta o piso do andar
         * de cima. Foi o primeiro resultado errado desta ferramenta. */
        const g = col.raycast(v3(x, a.y + 0.6, z), v3(0, -1, 0), 6);
        const y = g.hit ? g.point.y + 0.02 : c.baseY + 0.2;
        const s = col.capsuleSweep(v3(x, y, z), v3(x, y, z), RAIO, ALT, 0.4);
        const desl = Math.hypot(s.position.x - x, s.position.z - z);
        // separa quem empurrou: repete sem os obstaculos moveis
        const guarda = col.obstaculos;
        col.obstaculos = [];
        const s2 = col.capsuleSweep(v3(x, y, z), v3(x, y, z), RAIO, ALT, 0.4);
        const deslBvh = Math.hypot(s2.position.x - x, s2.position.z - z);
        col.obstaculos = guarda;
        /* Quem esta barrando: leque de 8 raios na altura do peito, com a
         * superficie e a distancia. Sem isto o diagnostico para em "algo empurra
         * a capsula" e vira adivinhacao. */
        let viz = null;
        if (deslBvh > 0.02) {
          viz = [];
          for (let k = 0; k < 8; k++) {
            const ang = (k / 8) * Math.PI * 2;
            const h = col.raycast(v3(x, y + 1.0, z), v3(Math.cos(ang), 0, Math.sin(ang)), 1.3);
            if (h.hit) viz.push(`${k * 45}d:${h.surface}@${h.distance.toFixed(2)}`);
          }
        }
        amostras.push({
          t: +t.toFixed(2), y: +y.toFixed(2),
          desl: +desl.toFixed(3), bvh: +deslBvh.toFixed(3), viz,
        });
      }
      linhas.push({
        anc: { x: +a.x.toFixed(2), y: +a.y.toFixed(2), z: +a.z.toFixed(2), nx: +a.nx.toFixed(2), nz: +a.nz.toFixed(2), w: a.w },
        amostras,
      });
    }
    out.push({
      i: casas.indexOf(c), x: +c.x.toFixed(1), z: +c.z.toFixed(1),
      w: +c.w.toFixed(1), d: +c.d.toFixed(1), yaw: +c.yaw.toFixed(3),
      baseY: +c.baseY.toFixed(2), interior: !!c.interior,
      nPortas: portas.length, nAnc: anc.length, linhas,
    });
  }
  return out;
}, CASA);

for (const c of r) {
  console.log(`\n=== casa #${c.i} (${c.x}, ${c.z}) ${c.w}x${c.d} base=${c.baseY} interior=${c.interior} portas=${c.nPortas} ancoras=${c.nAnc}`);
  for (const L of c.linhas) {
    console.log(`  porta em (${L.anc.x}, ${L.anc.y}, ${L.anc.z}) n=(${L.anc.nx},${L.anc.nz}) largura=${L.anc.w}`);
    console.log('   t(m)   y    deslocado  so-BVH   (deslocado > 0.02 = barrado)');
    for (const a of L.amostras) {
      const marca = a.desl > 0.02 ? (a.bvh > 0.02 ? ' <- BVH' : ' <- folha') : '';
      console.log(`   ${String(a.t).padStart(5)}  ${String(a.y).padStart(6)}  ${String(a.desl).padStart(8)}  ${String(a.bvh).padStart(7)}${marca}`);
      if (a.viz && a.viz.length) console.log(`          em volta: ${a.viz.join(' | ')}`);
    }
  }
}

await b.close();
vite.kill();
