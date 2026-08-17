/**
 * Batedor de enquadramento.
 *
 * Para cada ponto de spawn testa N direções, medindo por raycast a distância
 * livre à frente e quanto do frustum é céu. Depois ordena e imprime as melhores
 * tomadas — enquadramento escolhido por medição, não por chute.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5181;

const vite = spawn(process.execPath,
  [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((res, rej) => {
  let o = ''; const h = (d) => { o += d; if (/ready in/.test(o)) res(); };
  vite.stdout.on('data', h); vite.stderr.on('data', h);
  setTimeout(() => rej(new Error('timeout vite')), 40000);
});

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__game?.ready, { timeout: 180000 });
await page.waitForTimeout(1500);

const resultado = await page.evaluate(() => {
  const ctx = window.__game.ctx;
  const THREE = window.__game.ctx.THREE_REF || null;
  const pts = ctx.world.getSpawnPoints();
  const col = ctx.world.collision;
  const out = [];

  const dir = { x: 0, y: 0, z: 0 };
  const org = { x: 0, y: 0, z: 0 };

  // Vetores three via a própria câmera (evita importar THREE aqui)
  const V = ctx.camera.position.constructor;   // THREE.Vector3
  const vOrg = new V(), vDir = new V();

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i].position ?? pts[i];
    for (let a = 0; a < 12; a++) {
      const yaw = a * 30;
      const r = yaw * Math.PI / 180;
      // yaw 0 = -Z, cresce para +X (mesma convenção do poseAt)
      vDir.set(-Math.sin(r), 0, -Math.cos(r)).normalize();
      vOrg.set(p.x, p.y + 1.68, p.z);

      const frente = col.raycast(vOrg, vDir, 60);
      const dFrente = frente?.hit ? frente.distance : 60;

      // amostra em leque para estimar abertura (quanto do campo é livre)
      let somaLivre = 0, amostras = 0, ceu = 0;
      for (let k = -3; k <= 3; k++) {
        const rk = r + k * 0.20;
        for (const pitch of [-0.12, 0.06, 0.28]) {
          const cp = Math.cos(pitch);
          vDir.set(-Math.sin(rk) * cp, Math.sin(pitch), -Math.cos(rk) * cp).normalize();
          const h = col.raycast(vOrg, vDir, 60);
          const d = h?.hit ? h.distance : 60;
          somaLivre += d; amostras++;
          if (!h?.hit) ceu++;
        }
      }
      out.push({
        spawn: i, yaw,
        pos: [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)],
        frente: +dFrente.toFixed(1),
        aberturaMedia: +(somaLivre / amostras).toFixed(1),
        pctCeu: +(100 * ceu / amostras).toFixed(0),
        superficie: frente?.surface ?? null,
      });
    }
  }
  return { total: pts.length, amostras: out };
});

const { total, amostras } = resultado;
console.log(`${total} pontos de spawn, ${amostras.length} direções testadas\n`);

// Corredor: frente livre razoável mas fechado (beco)
const becos = amostras
  .filter((a) => a.frente > 9 && a.frente < 32 && a.pctCeu < 22)
  .sort((x, y) => y.frente - x.frente).slice(0, 8);

// Aberto: muita abertura e céu (laje, praça)
const abertos = amostras
  .filter((a) => a.aberturaMedia > 24 && a.pctCeu > 38)
  .sort((x, y) => y.aberturaMedia - x.aberturaMedia).slice(0, 8);

// Perto de parede — bom para tiro/clarão
const paredes = amostras
  .filter((a) => a.frente > 2.5 && a.frente < 6 && a.pctCeu < 30)
  .sort((x, y) => x.frente - y.frente).slice(0, 6);

const tab = (t, l) => {
  console.log(`--- ${t} ---`);
  console.log('spawn yaw   pos                frente  abertura  céu%  superfície');
  for (const a of l) {
    console.log(
      String(a.spawn).padStart(4), String(a.yaw).padStart(4), ' ',
      JSON.stringify(a.pos).padEnd(20),
      String(a.frente).padStart(5), String(a.aberturaMedia).padStart(8),
      String(a.pctCeu).padStart(5), ' ', a.superficie ?? '-',
    );
  }
  console.log('');
};
tab('BECOS / CORREDORES', becos);
tab('ABERTOS / LAJES', abertos);
tab('PERTO DE PAREDE (clarão)', paredes);

await writeFile(path.join(ROOT, 'tools', 'scout.json'),
  JSON.stringify({ becos, abertos, paredes }, null, 2));

await browser.close();
vite.kill();
