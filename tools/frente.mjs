/**
 * frente.mjs — para que lado a malha olha quando `yaw` aponta para o jogador?
 *
 * Existe porque a resposta NÃO é dedutível com segurança do código: o mesh do
 * `Soldier` é autorado com a cara em -Z ("frente = -Z, padrão Object3D"), mas
 * `Perception` recebe `_frente = (sin(yaw), 0, cos(yaw))`, que é o +Z local. Se
 * as duas convenções estiverem trocadas, o hostil enxerga pelas costas — ou o
 * mesh vira ao contrário. Os dois defeitos são invisíveis num laudo de número e
 * gritantes numa foto.
 *
 * Põe soldado e drone lado a lado com o MESMO `yaw` (o que `spawnPerto` chama
 * de "vira de frente para o jogador") e fotografa. Quem estiver de costas na
 * imagem está errado.
 *
 * Uso: node tools/frente.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 5287);
const OUT = ROOT + '/shots/drone';
mkdirSync(OUT, { recursive: true });

const vite = spawn(process.execPath, [
  ROOT + '/node_modules/vite/bin/vite.js',
  '--config', 'tools/vite.diag.config.js',
  '--host', '127.0.0.1', '--port', String(PORT), '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r, j) => {
  const t = setTimeout(() => j(new Error('timeout vite')), 60000);
  vite.stdout.on('data', (d) => { if (/ready in|Local:/i.test(String(d))) { clearTimeout(t); r(); } });
});

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERR:', String(e).split('\n')[0]));
await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready, undefined, { timeout: 240000 });
await page.waitForTimeout(1200);

const r = await page.evaluate(() => {
  const ctx = window.__game.ctx;
  const ai = ctx.ai;
  ctx.state = 'jogando';
  ctx.menu?.hideAll?.();
  ctx.hud?.setVisible?.(false);
  ctx.viewScene.visible = false;
  ai.reset();
  ai.spawnAutomatico = false;
  ctx.player.update(1 / 60);

  /* PROCURA UM LUGAR ABERTO. O ponto de nascimento do jogador cai dentro de
   * uma casa com frequência, e a primeira passagem desta ferramenta fotografou
   * uma parede com o drone do tamanho de uma formiga no canto. Aqui varremos os
   * pontos de spawn e ficamos com o que tem mais céu em volta: 12 raios
   * horizontais a 1,5 m, pontuando quantos passam de 9 m. */
  const col = ctx.world.collision;
  const V = ctx.camera.position.constructor;
  const pts = ctx.world.getSpawnPoints();
  let melhor = null, melhorNota = -1, melhorRumo = 0;
  for (const sp of pts) {
    const q = sp.position ?? sp;
    let nota = 0, rumo = 0, melhorLivre = 0;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const d = new V(Math.sin(a), 0, Math.cos(a));
      const o = new V(q.x, q.y + 1.5, q.z);
      const r = col.raycast(o, d, 14);
      const livre = (r && r.hit) ? r.distance : 14;
      if (livre > 9) nota++;
      if (livre > melhorLivre) { melhorLivre = livre; rumo = a; }
    }
    if (nota > melhorNota) { melhorNota = nota; melhor = q; melhorRumo = rumo; }
  }
  if (!melhor) return { ok: false, motivo: 'sem ponto aberto' };

  /* Câmera no ponto aberto, olhando na direção mais desimpedida; os dois
   * bonecos a 5 m nessa direção. */
  const fx = Math.sin(melhorRumo), fz = Math.cos(melhorRumo);
  const lx = Math.cos(melhorRumo), lz = -Math.sin(melhorRumo);   // lateral
  const camX = melhor.x, camY = melhor.y + 1.6, camZ = melhor.z;
  const baseX = camX + fx * 5.0, baseZ = camZ + fz * 5.0;
  const chaoS = col.groundAt(baseX - lx * 1.3, baseZ - lz * 1.3);
  const chaoD = col.groundAt(baseX + lx * 1.3, baseZ + lz * 1.3);

  const soldado = ai.spawn({ x: baseX - lx * 1.3, y: chaoS, z: baseZ - lz * 1.3 }, 0, [], 'solo');
  const drone = ai.spawn({ x: baseX + lx * 1.3, y: chaoD, z: baseZ + lz * 1.3 }, 0, [], 'drone');
  if (!soldado || !drone) return { ok: false, motivo: 'spawn falhou' };
  const p = { x: camX, y: camY, z: camZ };

  /* O MESMO cálculo de `AIManager.spawnPerto`, cujo comentário diz
   * literalmente "vira de frente para o jogador". */
  const yawPara = (o) => Math.atan2(camX - o.pos.x, camZ - o.pos.z);

  soldado.yaw = soldado.yawAlvo = yawPara(soldado);
  soldado.soldado.grupo.position.copy(soldado.pos);
  soldado.soldado.grupo.rotation.y = soldado.yaw;
  soldado.soldado.update(1 / 60);
  soldado.soldado.grupo.updateMatrixWorld(true);

  drone.pos.set(baseX + lx * 1.3, chaoD + 1.45, baseZ + lz * 1.3);
  drone.yaw = drone.yawAlvo = yawPara(drone);
  drone.arfagem = 0; drone.rolagem = 0;
  drone._pose(0);

  ctx.state = 'pausado';
  ctx.camera.up.set(0, 1, 0);
  ctx.camera.position.set(camX, camY, camZ);
  ctx.camera.lookAt(baseX, chaoD + 1.15, baseZ);
  ctx.camera.fov = 55; ctx.camera.updateProjectionMatrix();
  ctx.camera.updateMatrixWorld(true);
  ctx.lighting?.update?.(0, ctx.time.elapsed);
  window.__game.settle(24);

  // Para onde aponta o +Z local de cada um?
  const eixo = (obj) => {
    const zMais = new V(0, 0, 1).applyQuaternion(obj.getWorldQuaternion(new (obj.quaternion.constructor)()));
    return { x: +zMais.x.toFixed(2), z: +zMais.z.toFixed(2) };
  };
  return {
    ok: true,
    yawSoldado: +soldado.yaw.toFixed(2),
    yawDrone: +drone.yaw.toFixed(2),
    zLocalSoldado: eixo(soldado.soldado.grupo),
    zLocalDrone: eixo(drone.corpo),
    // direção da câmera a partir de cada boneco (o que "de frente" deveria ser)
    paraCameraSoldado: { x: +(camX - soldado.pos.x).toFixed(2), z: +(camZ - soldado.pos.z).toFixed(2) },
    aberturaDoPonto: melhorNota,
  };
});

await page.screenshot({ path: OUT + '/frente-descartada.png' });
/* Esconder o menu ANTES de pausar não basta: pausar é justamente o que o traz
 * de volta. A ordem que funciona é pausar, compor, esconder e só então
 * fotografar. A primeira captura acima continua sendo descartada por contrato. */
await page.evaluate(() => {
  const ctx = window.__game.ctx;
  ctx.menu?.hideAll?.();
  ctx.hud?.setVisible?.(false);
  ctx.viewScene.visible = false;
  window.__game.settle(10);
});
await page.waitForTimeout(300);
await page.screenshot({ path: OUT + '/frente-soldado-x-drone.png' });

console.log(JSON.stringify(r, null, 2));
console.log('');
console.log('-> shots/drone/frente-soldado-x-drone.png');
console.log('   ESQUERDA = soldado, DIREITA = drone, ambos com o yaw que');
console.log('   `AIManager.spawnPerto` usa para "virar de frente para o jogador".');

await browser.close();
vite.kill();
