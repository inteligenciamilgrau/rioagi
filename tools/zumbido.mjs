/**
 * O zumbido do enxame nao pode sobreviver a simulacao parada.
 *
 * O relato: "quando morre, o som dos drones fica tocando". A causa e que quem
 * comanda o zumbido (`AIManager._zumbir`) para de rodar fora de 'jogando', e a
 * ultima ordem fica valendo para sempre.
 *
 * O teste mede o GANHO REAL do no de saida do enxame, nao um sinalizador — um
 * booleano interno poderia dizer "calado" com o oscilador ainda soando.
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 5281);

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
  executablePath: process.env.PW_CHROME || undefined,
  // Sem flag de autoplay: queremos o comportamento real do navegador.
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERR:', String(e).split('\n')[0]));
await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready, undefined, { timeout: 240000 });
await page.waitForTimeout(1200);

let falhas = 0;
const checa = (n, ok, d = '') => {
  console.log((ok ? '  OK  ' : ' FALHA') + '  ' + n + (d ? '   ' + d : ''));
  if (!ok) falhas++;
};

const r = await page.evaluate(async () => {
  const ctx = window.__game.ctx;
  const A = ctx.audio;
  await A.resume?.();

  // Ganho de saida da cadeia do enxame — a unica prova que vale.
  const ganho = () => {
    const nos = A._enxNos;
    if (!nos) return null;
    const g = nos.saida ?? nos.ganho ?? nos.gain ?? nos.out;
    return g?.gain ? +g.gain.value.toFixed(4) : null;
  };

  const passo = (n) => { for (let i = 0; i < n; i++) A.update(1 / 60); };
  const pos = ctx.player.position;

  ctx.state = 'jogando';
  // Enxame perto e barulhento.
  A.zumbidoEnxame({ x: pos.x + 6, y: pos.y + 3, z: pos.z + 6 }, 8, 6, 0.8);
  passo(30);
  await new Promise((ok) => setTimeout(ok, 400));
  const tocando = ganho();

  // Morre: o AIManager para de rodar, mas o AudioEngine continua.
  /* O silenciamento e por RAMPA, nao corte seco (corte seco em oscilador da
   * estalo). Entao amostramos a curva ate 3 s em vez de espiar um instante
   * arbitrario — a primeira versao deste teste media aos 500 ms, no meio da
   * descida, e acusava falha num comportamento correto. */
  ctx.state = 'morto';
  const curva = [];
  for (let k = 0; k < 12; k++) {
    passo(15);
    await new Promise((ok) => setTimeout(ok, 250));
    curva.push({ t: +((k + 1) * 0.25).toFixed(2), g: ganho() });
  }
  const aposMorte = ganho();

  // Pausa: mesmo problema, mesma cura.
  ctx.state = 'jogando';
  A.zumbidoEnxame({ x: pos.x + 6, y: pos.y + 3, z: pos.z + 6 }, 8, 6, 0.8);
  passo(30);
  await new Promise((ok) => setTimeout(ok, 400));
  const tocandoDeNovo = ganho();
  ctx.state = 'pausado';
  // Mesma rampa da morte — esperar 500 ms mediria a descida, nao o fim.
  for (let k = 0; k < 8; k++) { passo(15); await new Promise((ok) => setTimeout(ok, 250)); }
  const aposPausa = ganho();

  // Voltando ao jogo o zumbido tem de poder voltar.
  ctx.state = 'jogando';
  A.zumbidoEnxame({ x: pos.x + 6, y: pos.y + 3, z: pos.z + 6 }, 8, 6, 0.8);
  passo(30);
  await new Promise((ok) => setTimeout(ok, 400));
  const voltou = ganho();

  return { tocando, aposMorte, curva, tocandoDeNovo, aposPausa, voltou };
});

console.log('');
console.log('=== ganho do zumbido do enxame ===');
checa('a cadeia existe e o teste consegue le-la', r.tocando !== null,
  r.tocando === null ? 'nao achei o no de saida' : '');
checa('com 8 drones perto: SOA', (r.tocando ?? 0) > 0.001, 'ganho ' + r.tocando);
const zerou = r.curva.find((p) => (p.g ?? 1) <= 0.0002);
console.log('  curva apos a morte: ' + r.curva.map((p) => p.t + 's=' + p.g).join('  '));
checa('depois de MORRER: cala de vez', (r.aposMorte ?? 1) <= 0.0002, 'ganho final ' + r.aposMorte);
checa('e cala em ate 3 s', !!zerou, zerou ? 'silencio aos ' + zerou.t + ' s' : 'nao zerou em 3 s');
checa('com 8 drones de novo: SOA', (r.tocandoDeNovo ?? 0) > 0.001, 'ganho ' + r.tocandoDeNovo);
checa('depois de PAUSAR: cala de vez', (r.aposPausa ?? 1) <= 0.0002, 'ganho ' + r.aposPausa);
checa('voltando ao jogo: SOA de novo', (r.voltou ?? 0) > 0.001, 'ganho ' + r.voltou);

await browser.close();
vite.kill();
console.log('');
console.log(falhas === 0 ? '>>> OK' : '>>> ' + falhas + ' FALHA(S)');
process.exit(falhas === 0 ? 0 : 1);
