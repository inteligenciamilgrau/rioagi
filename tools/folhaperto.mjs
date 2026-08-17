/**
 * folhaperto.mjs — a folhagem em resoluçao de jogo (1280x720) a distancia de
 * encostar o rosto. E o teste mais duro: a 1,2 m um cartao com alfa mostra
 * qualquer defeito de silhueta, de mip e de densidade de texel.
 *
 * Saida: shots/folha-perto.png (mosaico de 4 poses)
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

const ROOT = process.cwd();
const PORT = process.env.PORT || 5173;
mkdirSync(ROOT + '/shots', { recursive: true });

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));
await p.route('**/@vite/client', (r) => r.abort());
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__game?.ready, null, { timeout: 240000 });
await p.waitForTimeout(2500);

const alvos = await p.evaluate(async () => {
  const THREE = window.__three ?? (window.__three = await import('/node_modules/three/build/three.module.js'));
  const ctx = window.__game.ctx;
  const m4 = new THREE.Matrix4(), pos = new THREE.Vector3(), esc = new THREE.Vector3(), q = new THREE.Quaternion();
  const achar = (tipo) => {
    let melhor = null;
    ctx.world.group.traverse((o) => {
      if (!o.isInstancedMesh || o.name.split(':')[1] !== tipo) return;
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m4); m4.decompose(pos, q, esc);
        const aberto = Math.max(Math.abs(pos.x), Math.abs(pos.z));
        const pontos = esc.x * 10 + (aberto > 30 && aberto < 78 ? 8 : 0);
        if (!melhor || pontos > melhor.pontos) melhor = { pontos, x: pos.x, y: pos.y, z: pos.z };
      }
    });
    return melhor;
  };
  return {
    moitaLonge: achar('moitaLonge'), arbusto: achar('arbusto'),
    capim: achar('capim'), bananeira: achar('bananeira'),
  };
});

const nomes = [];
for (const [nome, a] of Object.entries(alvos)) {
  if (!a) continue;
  const alturaAlvo = nome === 'capim' ? 0.4 : nome === 'bananeira' ? 2.4 : 0.7;
  const dist = nome === 'bananeira' ? 2.6 : 1.2;
  await p.evaluate(([q, d, ha]) => {
    const ctx = window.__game.ctx;
    ctx.state = 'pausado';
    const alvoY = q.y + ha;
    let melhor = null;
    for (let k = 0; k < 32; k++) {
      const ang = (k / 32) * Math.PI * 2;
      const cx = q.x + Math.sin(ang) * d, cz = q.z + Math.cos(ang) * d;
      const chao = ctx.world.collision.raycast({ x: cx, y: q.y + 30, z: cz }, { x: 0, y: -1, z: 0 }, 70);
      const cy = (chao.hit ? chao.point.y : ctx.world.heightAt(cx, cz)) + 1.5;
      // quer o sol atras da folha quando possivel: contraluz denuncia alfa ruim
      const sol = ctx.lighting?.sunDirection;
      const contraluz = sol ? -(Math.sin(ang) * sol.x + Math.cos(ang) * sol.z) : 0;
      const pontos = contraluz - Math.abs(cy - alvoY) * 2;
      if (!melhor || pontos > melhor.pontos) melhor = { pontos, cx, cy, cz };
    }
    ctx.camera.position.set(melhor.cx, melhor.cy, melhor.cz);
    ctx.camera.lookAt(q.x, alvoY, q.z);
    ctx.camera.updateMatrixWorld(true);
    ctx.menu?.hideAll?.(); ctx.hud?.setVisible?.(false);
    const ui = document.getElementById('ui-root'); if (ui) ui.style.display = 'none';
    window.__game.settle(18);
  }, [a, dist, alturaAlvo]);
  await p.screenshot({ path: `${ROOT}/shots/_fp-${nome}.png` });
  nomes.push([nome, dist]);
  console.log(`  ${nome} @ ${dist} m`);
}

const m = await b.newPage({ viewport: { width: 2580, height: 1480 } });
const html = nomes.map(([n, d]) => {
  const b64 = readFileSync(`${ROOT}/shots/_fp-${n}.png`).toString('base64');
  return `<figure><img src="data:image/png;base64,${b64}"><figcaption>${n} @ ${d} m</figcaption></figure>`;
}).join('');
await m.setContent(`<style>body{margin:0;background:#111;font:15px monospace;color:#eee}
  main{display:grid;grid-template-columns:repeat(2,1280px);gap:6px;padding:6px}
  figure{margin:0;position:relative}img{display:block;width:1280px}
  figcaption{position:absolute;left:6px;top:6px;background:#000b;padding:4px 9px}</style><main>${html}</main>`);
await m.screenshot({ path: `${ROOT}/shots/folha-perto.png`, fullPage: true });
console.log('-> shots/folha-perto.png');
await b.close();
