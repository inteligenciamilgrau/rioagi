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

  /* QUATRO sujeitos numa fileira. Dois soldados e dois drones, cada par com o
   * yaw "de frente para o jogador" e com esse yaw MAIS 180 graus. Qual dos dois
   * mostra a fenda ciano responde a pergunta sem margem para interpretação. */
  const off = [-3.0, -1.0, 1.0, 3.0];
  const lugar = (i) => {
    const x = baseX + lx * off[i], z = baseZ + lz * off[i];
    return { x, y: col.groundAt(x, z), z };
  };
  const sujeitos = [];
  const yawPara = (o) => Math.atan2(camX - o.pos.x, camZ - o.pos.z);

  for (let i = 0; i < 4; i++) {
    const L = lugar(i);
    const tipo = i < 2 ? 'solo' : 'drone';
    const e = ai.spawn(L, 0, [], tipo);
    if (!e) continue;
    const virado = (i % 2 === 1);
    if (tipo === 'solo') {
      e.pos.set(L.x, L.y, L.z);
      e.yaw = e.yawAlvo = yawPara(e) + (virado ? Math.PI : 0);
      e.soldado.grupo.position.copy(e.pos);
      e.soldado.grupo.rotation.y = e.yaw;
      e.soldado.update(1 / 60);
      e.soldado.grupo.updateMatrixWorld(true);
    } else {
      e.pos.set(L.x, L.y + 1.45, L.z);
      e.yaw = e.yawAlvo = yawPara(e) + (virado ? Math.PI : 0);
      e.arfagem = 0; e.rolagem = 0;
      e._pose(0);
    }
    sujeitos.push({ tipo, virado, id: e.id });
  }
  const soldado = ai.vivos.find((x) => !x.eDrone);
  const drone = ai.vivos.find((x) => x.eDrone);
  const p = { x: camX, y: camY, z: camZ };

  ctx.state = 'pausado';
  ctx.camera.up.set(0, 1, 0);
  ctx.camera.position.set(camX, camY, camZ);
  ctx.camera.lookAt(baseX, chaoD + 1.15, baseZ);
  ctx.camera.fov = 55; ctx.camera.updateProjectionMatrix();
  ctx.camera.updateMatrixWorld(true);
  ctx.lighting?.update?.(0, ctx.time.elapsed);
  window.__game.settle(24);

  /* VEREDITO POR MARCO ANATÔMICO, não por eixo.
   *
   * "O +Z local aponta para a câmera" só responde a pergunta se soubermos, sem
   * dúvida, de que lado do modelo está a cara — e é justamente isso que estava
   * em disputa. Então comparamos dois pontos CONHECIDOS da malha: um que só
   * existe na frente e um que só existe atrás. Quem estiver mais perto da
   * câmera decide, e não há interpretação possível.
   *
   *   Soldier  frente = fenda óptica  (0, 1.691, -0.104)
   *            costas = barra de sinal (0, 1.402, +0.186)
   *   Drone    frente = fenda óptica  (0, 0.006, -0.322)
   *            costas = antena        (0.048, 0.306, +0.238) */
  const cam = new V(camX, camY, camZ);
  const veredito = (obj, frente, tras) => {
    obj.updateMatrixWorld(true);
    const f = frente.clone().applyMatrix4(obj.matrixWorld);
    const t = tras.clone().applyMatrix4(obj.matrixWorld);
    const df = f.distanceTo(cam), dt = t.distanceTo(cam);
    return {
      distFrente: +df.toFixed(2), distTras: +dt.toFixed(2),
      mostra: df < dt ? 'FRENTE' : 'COSTAS',
    };
  };
  const soldados = ai.vivos.filter((x) => !x.eDrone);
  const drones = ai.vivos.filter((x) => x.eDrone);
  const relat = [];
  for (const s of soldados) {
    relat.push({
      tipo: 'soldado', yaw: +s.yaw.toFixed(2),
      ...veredito(s.soldado.grupo, new V(0, 1.691, -0.104), new V(0, 1.402, 0.186)),
    });
  }
  for (const d of drones) {
    relat.push({
      tipo: 'drone', yaw: +d.yaw.toFixed(2),
      ...veredito(d.corpo, new V(0, 0.006, -0.322), new V(0.048, 0.306, 0.238)),
    });
  }
  return { ok: true, aberturaDoPonto: melhorNota, sujeitos, relat };
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
