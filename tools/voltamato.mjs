/**
 * voltamato.mjs — prova visual da folhagem.
 *
 *  1. VARREDURA 360: no spawn que estava vedado (o mesmo que `semcapim.mjs`
 *     escolhe: primeiro spawn com chao de terra), 12 fotos de 30 em 30 graus,
 *     montadas num mosaico unico.
 *  2. ESCADA DE DISTANCIA: a mesma moita/arbusto vista colada (2 m), a media
 *     distancia (10 m) e longe (40 m) — a falha pode estar num LOD so.
 *
 * Uso: node tools/voltamato.mjs <rotulo>
 * Saida: shots/mato-360-<rotulo>.png e shots/mato-escada-<rotulo>.png
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

const ROOT = process.cwd();
const PORT = process.env.PORT || 5173;
const ROTULO = process.argv[2] ?? 'depois';
mkdirSync(ROOT + '/shots', { recursive: true });

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 480, height: 270 } });
p.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));
await p.route('**/@vite/client', (r) => r.abort());
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__game?.ready, null, { timeout: 240000 });
await p.waitForTimeout(2000);
await p.evaluate(() => {
  const ctx = window.__game.ctx;
  ctx.state = 'jogando'; ctx.bus.emit('game:start', {});
});
await p.waitForTimeout(700);

const esconder = () => p.evaluate(() => {
  const ctx = window.__game.ctx;
  ctx.menu?.hideAll?.(); ctx.hud?.setVisible?.(false);
  const ui = document.getElementById('ui-root'); if (ui) ui.style.display = 'none';
  window.__game.settle(16);
});

// ---------------------------------------------------------------- 1) 360
const alvo = await p.evaluate(() => {
  const ctx = window.__game.ctx;
  for (const s of ctx.world.getSpawnPoints()) {
    const q = s.position ?? s;
    const g = ctx.world.collision.raycast({ x: q.x, y: q.y + 2, z: q.z }, { x: 0, y: -1, z: 0 }, 6);
    if (g.hit && g.surface === 'terra') return { x: q.x, y: q.y, z: q.z };
  }
  return null;
});
console.log(`spawn de terra: (${alvo.x.toFixed(1)}, ${alvo.z.toFixed(1)})`);

const graus = [];
for (let g = 0; g < 360; g += 30) graus.push(g);
for (const g of graus) {
  await p.evaluate(([q, deg]) => {
    const ctx = window.__game.ctx;
    ctx.player.movement.teleport(q.x, q.y + 0.1, q.z);
    ctx.player.rig.reset(deg * Math.PI / 180, 0);
    for (let f = 0; f < 60; f++) ctx.player.update(1 / 60);
  }, [alvo, g]);
  await esconder();
  await p.screenshot({ path: `${ROOT}/shots/_v360-${g}.png` });
}
{
  const m = await b.newPage({ viewport: { width: 1460, height: 4 * 292 + 20 } });
  const imgs = graus.map((g) => {
    const b64 = readFileSync(`${ROOT}/shots/_v360-${g}.png`).toString('base64');
    return `<figure><img src="data:image/png;base64,${b64}"><figcaption>${g}&deg;</figcaption></figure>`;
  }).join('');
  await m.setContent(`<style>body{margin:0;background:#111;font:12px monospace;color:#eee}
    main{display:grid;grid-template-columns:repeat(3,480px);gap:4px;padding:4px}
    figure{margin:0;position:relative}img{display:block;width:480px}
    figcaption{position:absolute;left:4px;top:4px;background:#000a;padding:2px 6px}</style><main>${imgs}</main>`);
  await m.screenshot({ path: `${ROOT}/shots/mato-360-${ROTULO}.png`, fullPage: true });
  await m.close();
  console.log(`-> shots/mato-360-${ROTULO}.png`);
}

// ---------------------------------------------------------------- 2) escada
// Escolhe uma moita bem no meio de um terreno aberto e fotografa a 2, 10 e 40 m,
// com a camera na altura do olho e apontada para o pe da planta.
const p2 = await b.newPage({ viewport: { width: 640, height: 400 } });
p2.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));
await p2.route('**/@vite/client', (r) => r.abort());
await p2.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await p2.waitForFunction(() => window.__game?.ready, null, { timeout: 240000 });
await p2.waitForTimeout(2500);

const alvos = await p2.evaluate(async () => {
  const THREE = window.__three ?? (window.__three = await import('/node_modules/three/build/three.module.js'));
  const ctx = window.__game.ctx;
  const m4 = new THREE.Matrix4(), pos = new THREE.Vector3(), esc = new THREE.Vector3(), q = new THREE.Quaternion();
  // `inst:<tipo>` ou `inst:<tipo>:<setor>` — comparar o TOKEN, senao 'arbusto'
  // casaria com 'arbusto2' e 'capim' com 'capimBaixo'.
  const achar = (tipo) => {
    let melhor = null;
    ctx.world.group.traverse((o) => {
      if (!o.isInstancedMesh || o.name.split(':')[1] !== tipo) return;
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m4); m4.decompose(pos, q, esc);
        // prefere a maior instancia em terreno aberto (longe do miolo apertado)
        const aberto = Math.max(Math.abs(pos.x), Math.abs(pos.z));
        const pontos = esc.x * 10 + (aberto > 40 && aberto < 80 ? 6 : 0);
        if (!melhor || pontos > melhor.pontos) {
          melhor = { pontos, x: pos.x, y: pos.y, z: pos.z, e: +esc.x.toFixed(2) };
        }
      }
    });
    return melhor;
  };
  return {
    moita: achar('moitaLonge'), arbusto: achar('arbusto'),
    capim: achar('capim'), bananeira: achar('bananeira'),
  };
});
console.log('alvos da escada:', JSON.stringify(alvos));

/**
 * Enquadra a planta a `dist` metros. A direçao NAO e fixa: varremos 24 azimutes
 * e ficamos com o que tem linha de visada limpa ate a planta (raycast de
 * colisao). Sem isso, a 40 m a foto vira parede de casa e nao prova nada.
 */
const tirar = async (nome, alvo2, dist, alturaAlvo) => {
  const ok = await p2.evaluate(([a, d, ha]) => {
    const ctx = window.__game.ctx;
    ctx.state = 'pausado';
    const cam = ctx.camera;
    const alvoY = a.y + ha;
    let melhor = null;
    for (let k = 0; k < 24; k++) {
      const ang = (k / 24) * Math.PI * 2;
      const cx = a.x + Math.sin(ang) * d, cz = a.z + Math.cos(ang) * d;
      // chao real (laje/telhado incluidos), nao so o terreno
      const chao = ctx.world.collision.raycast(
        { x: cx, y: a.y + 40, z: cz }, { x: 0, y: -1, z: 0 }, 90);
      const cy = (chao.hit ? chao.point.y : ctx.world.heightAt(cx, cz)) + 1.68;
      const dx = a.x - cx, dy = alvoY - cy, dz = a.z - cz;
      const l = Math.hypot(dx, dy, dz) || 1;
      const h = ctx.world.collision.raycast(
        { x: cx, y: cy, z: cz }, { x: dx / l, y: dy / l, z: dz / l }, l - 0.2);
      const livre = !h.hit;
      // penaliza desnivel: a foto tem de ser da planta, nao do barranco na frente
      const pontos = (livre ? 100 : 0) + (h.hit ? h.distance : 0) - Math.abs(cy - alvoY) * 3;
      if (!melhor || pontos > melhor.pontos) melhor = { pontos, cx, cy, cz, livre };
    }
    cam.position.set(melhor.cx, melhor.cy, melhor.cz);
    cam.lookAt(a.x, alvoY, a.z);
    cam.updateMatrixWorld(true);
    ctx.menu?.hideAll?.(); ctx.hud?.setVisible?.(false);
    const ui = document.getElementById('ui-root'); if (ui) ui.style.display = 'none';
    window.__game.settle(16);
    return melhor.livre;
  }, [alvo2, dist, alturaAlvo]);
  if (!ok) console.log(`  aviso: ${nome} @ ${dist} m sem linha de visada limpa`);
  await p2.screenshot({ path: `${ROOT}/shots/_esc-${nome}-${dist}.png` });
};

const linhas = [];
for (const [nome, a] of Object.entries(alvos)) {
  if (!a) continue;
  const ha = nome === 'capim' ? 0.45 : nome === 'bananeira' ? 2.2 : 0.8;
  for (const d of [2, 10, 40]) await tirar(nome, a, d, ha);
  linhas.push(nome);
}
{
  const m = await b.newPage({ viewport: { width: 1960, height: linhas.length * 424 + 20 } });
  let html = '';
  for (const nome of linhas) {
    for (const d of [2, 10, 40]) {
      const b64 = readFileSync(`${ROOT}/shots/_esc-${nome}-${d}.png`).toString('base64');
      html += `<figure><img src="data:image/png;base64,${b64}"><figcaption>${nome} @ ${d} m</figcaption></figure>`;
    }
  }
  await m.setContent(`<style>body{margin:0;background:#111;font:13px monospace;color:#eee}
    main{display:grid;grid-template-columns:repeat(3,640px);gap:4px;padding:4px}
    figure{margin:0;position:relative}img{display:block;width:640px}
    figcaption{position:absolute;left:4px;top:4px;background:#000a;padding:3px 7px}</style><main>${html}</main>`);
  await m.screenshot({ path: `${ROOT}/shots/mato-escada-${ROTULO}.png`, fullPage: true });
  await m.close();
  console.log(`-> shots/mato-escada-${ROTULO}.png`);
}

await b.close();
