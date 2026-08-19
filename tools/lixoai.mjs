/**
 * lixoai.mjs — QUEM ALOCA DENTRO DA IA, com bytes.
 *
 * O relatorio do `pico.mjs` acusa >= 650 KB por quadro e o `miolo.mjs` mostra
 * que a conta sobe ~58 KB por hostil de chao por quadro. Falta o nome da linha.
 *
 * O amostrador de alocacao do V8 via CDP NAO serve neste projeto: erra por mais
 * de 1000x e nao enxerga alocacao de vida curta (NOTES [CORE] secao 7, aferido
 * com alocador de tamanho conhecido). O que serve e a soma das SUBIDAS de
 * `performance.memory.usedJSHeapSize`, que e um PISO (subestimou 2x no
 * controle) — nunca um teto. Aqui isso basta: a pergunta e "quem", nao
 * "exatamente quanto".
 *
 * Metodo: laco sincrono de N chamadas do MESMO metodo, com o resto do jogo
 * parado, medindo o heap antes e depois. Laco sincrono bloqueia o rAF — e aqui
 * isso e uma VANTAGEM, porque nenhum outro sistema aloca no meio da conta.
 *
 * Uso:  node tools/lixoai.mjs
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 5317);
const N = Number(process.env.N ?? 4000);

const vite = spawn(process.execPath, [
  ROOT + '/node_modules/vite/bin/vite.js',
  '--config', 'tools/vite.hires.config.js',
  '--host', '127.0.0.1', '--port', String(PORT), '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r, j) => {
  const t = setTimeout(() => j(new Error('timeout vite')), 60000);
  vite.stdout.on('data', (d) => { if (/ready in|Local:/i.test(String(d))) { clearTimeout(t); r(); } });
});

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu',
    '--enable-unsafe-swiftshader', '--enable-precise-memory-info',
    '--js-flags=--expose-gc', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERR:', String(e).split('\n')[0]));
await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready, undefined, { timeout: 300000 });
await page.mouse.click(640, 360);
await page.waitForTimeout(1500);

const r = await page.evaluate(async ({ N }) => {
  const ctx = window.__game.ctx;
  const jog = ctx.player;
  jog.alive = true; jog.health = jog.maxHealth;
  if (!jog.__blindado) { const o = jog.takeDamage.bind(jog); jog.takeDamage = () => jog.health; jog.__blindado = o; }

  // campo povoado e em combate, para os metodos rodarem no caminho quente
  ctx.menu?.hideAll?.();
  ctx.state = 'jogando';
  ctx.bus.emit('game:start', {});
  if (ctx.progressao) ctx.progressao.fase = 'fim';
  ctx.ai.spawnAutomatico = false;
  ctx.ai.maxVivos = 18; ctx.ai.maxDrones = 6; ctx.ai.maxAtiradores = 4;
  ctx.ai.reset();
  ctx.ai.spawnOnda(12, 13, 42, 'solo');
  ctx.ai.spawnOnda(6, 15, 42, 'drone');
  ctx.ai.convergirNoJogador(1.2);
  await new Promise((res) => setTimeout(res, 4000));

  const solo = ctx.ai.vivos.find((e) => !e.eDrone && e.alive);
  const drone = ctx.ai.vivos.find((e) => e.eDrone && e.alive);
  if (!solo || !drone) return { erro: 'campo vazio: nao ha o que medir' };

  const mem = () => performance.memory.usedJSHeapSize;
  const V3 = ctx.camera.position.constructor;
  const olho = new V3(), frente = new V3(0, 0, 1), baixo = new V3(0, -1, 0);
  solo.soldado.posOlho(olho);
  const col = ctx.world.collision;

  const medir = (nome, fn, n = N) => {
    // aquece (o primeiro uso monta forma escondida, cache de linha, etc)
    for (let i = 0; i < 200; i++) fn(i);
    const a = mem();
    for (let i = 0; i < n; i++) fn(i);
    const b = mem();
    return { nome, bytes: Math.max(0, (b - a)) / n };
  };

  const out = [];
  out.push(medir('vazio (custo do proprio laco)', () => { }));
  out.push(medir('collision.raycast', () => col.raycast(olho, baixo, 40)));
  out.push(medir('collision.sphereCast(maxDist 0)', () => col.sphereCast(drone.pos, frente, 0.42, 0)));
  out.push(medir('Perception.update', () => solo.percepcao.update(1 / 60, olho, frente, jog, true)));
  out.push(medir('Soldier.update', () => solo.soldado.update(1 / 60)));
  out.push(medir('Enemy._mover', () => solo._mover(1 / 60)));
  out.push(medir('Enemy._apontar', () => solo._apontar(1 / 60, jog)));
  out.push(medir('Enemy._pensar', () => solo._pensar(1 / 60, jog)));
  out.push(medir('Enemy.update (inteiro)', () => solo.update(1 / 60, true)));
  out.push(medir('Drone._mover', () => drone._mover(1 / 60)));
  out.push(medir('Drone._pose', () => drone._pose(1 / 60)));
  out.push(medir('Drone.update (inteiro)', () => drone.update(1 / 60, true)));
  out.push(medir('AIManager.update (campo cheio)', () => ctx.ai.update(1 / 60, 0), Math.min(N, 1500)));

  // quebra do Soldier.update
  const S = solo.soldado;
  out.push(medir('  > Soldier._zerarPose', () => S._zerarPose()));
  out.push(medir('  > Soldier.grupo.updateMatrixWorld', () => S.grupo.updateMatrixWorld(true)));
  const pose = S._pose || {};
  out.push(medir('  > Soldier._locomocao', () => S._locomocao(1 / 60, pose)));
  out.push(medir('  > Soldier._postura', () => S._postura(pose)));
  out.push(medir('  > Soldier._aplicarPernasTorso', () => S._aplicarPernasTorso(pose)));
  out.push(medir('  > Soldier._olhar', () => S._olhar(pose)));
  out.push(medir('  > Soldier._posicionarArma', () => S._posicionarArma(pose)));
  out.push(medir('  > Soldier._bracosNaArma', () => S._bracosNaArma(1 / 60, pose)));
  out.push(medir('  > Soldier._sanearOssos', () => S._sanearOssos()));

  return { out, vivos: ctx.ai.vivos.filter((e) => e.alive).length };
}, { N });

await browser.close();
vite.kill();

console.log('');
console.log('=========================================================================');
console.log('ALOCACAO POR CHAMADA — piso, nunca teto (ver NOTES [CORE] secao 7)');
console.log('=========================================================================');
if (r.erro) { console.log('  ' + r.erro); process.exit(1); }
console.log('  campo: ' + r.vivos + ' vivos · ' + N + ' chamadas por medida');
console.log('');
console.log('  metodo                                bytes/chamada   por quadro com 12 deles');
for (const x of r.out) {
  const b = x.bytes;
  console.log('  ' + x.nome.padEnd(38) + b.toFixed(0).padStart(10)
    + (x.nome.startsWith('  >') || x.nome.includes('AIManager') || x.nome.includes('vazio')
      ? '' : (b * 12 / 1024).toFixed(1).padStart(20) + ' KB'));
}
