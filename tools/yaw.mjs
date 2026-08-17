/**
 * yaw.mjs — mede EMPIRICAMENTE a convencao de yaw do CameraRig.
 *
 * Nao assume nada: aplica varios yaws no rig de verdade (rig.reset + update +
 * applyTo) e le camera.getWorldDirection() em coordenadas de mundo.
 * Depois confere qual formula (atan2(-dx,-dz) ou atan2(dx,dz)) faz a camera
 * OLHAR PARA um alvo, em vez de dar as costas para ele.
 */
import { chromium } from 'playwright';

const PORT = process.env.PORT || 5173;
const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
p.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__game?.ready, { timeout: 180000 });
await p.waitForTimeout(1500);

const r = await p.evaluate(() => {
  const ctx = window.__game.ctx;
  const rig = ctx.player.rig;
  const cam = ctx.camera;
  const V = ctx.player.position.constructor;   // THREE.Vector3

  const dirDoYaw = (yawRad) => {
    rig.reset(yawRad, 0);
    // update com estado minimo: sem bob, sem recuo -> direcao pura do yaw
    rig.update(0.016, { position: ctx.player.position, eyeHeight: 1.68, planarSpeed: 0, grounded: true });
    rig.applyTo(cam);
    cam.updateMatrixWorld(true);
    const d = new V();
    cam.getWorldDirection(d);
    return [+d.x.toFixed(4), +d.y.toFixed(4), +d.z.toFixed(4)];
  };

  const tabela = [];
  for (const g of [0, 45, 90, 135, 180, 225, 270, 315]) {
    tabela.push({ yawGraus: g, dir: dirDoYaw(g * Math.PI / 180) });
  }

  /* --- teste do alvo: estou em p, quero olhar para t --- */
  const casos = [];
  const pos = { x: 30, z: -20 };
  for (const t of [{ x: 0, z: 0 }, { x: 50, z: 50 }, { x: -40, z: 10 }]) {
    const dx = t.x - pos.x, dz = t.z - pos.z;
    const len = Math.hypot(dx, dz);
    const alvoUnit = [+(dx / len).toFixed(3), +(dz / len).toFixed(3)];
    const fA = Math.atan2(-dx, -dz);   // formula usada hoje no Player/World (com dx=-p.x)
    const fB = Math.atan2(dx, dz);     // a outra
    const dA = dirDoYaw(fA), dB = dirDoYaw(fB);
    // produto escalar (so XZ) entre a direcao da camera e a direcao ate o alvo
    const dotA = +(dA[0] * alvoUnit[0] + dA[2] * alvoUnit[1]).toFixed(3);
    const dotB = +(dB[0] * alvoUnit[0] + dB[2] * alvoUnit[1]).toFixed(3);
    casos.push({ de: pos, para: t, alvoUnit, dotA, dotB });
  }
  return { tabela, casos };
});

console.log('\n=== yaw -> getWorldDirection (mundo) ===');
console.log('yaw(graus)   dir.x     dir.y     dir.z');
for (const t of r.tabela) {
  console.log(String(t.yawGraus).padStart(6), '   ', t.dir.map((n) => String(n).padStart(8)).join(' '));
}
console.log('\n=== qual formula olha PARA o alvo? (dot 1 = olhando para, -1 = de costas) ===');
for (const c of r.casos) {
  console.log(`de (${c.de.x},${c.de.z}) para (${c.para.x},${c.para.z})  dirAteAlvo=[${c.alvoUnit}]`);
  console.log(`   atan2(-dx,-dz) -> dot ${c.dotA}     atan2(dx,dz) -> dot ${c.dotB}`);
}
await b.close();
