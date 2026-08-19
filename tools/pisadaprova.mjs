/**
 * pisadaprova.mjs — prova de mecanismo: qual das tres suspeitas trava o pe?
 *
 * Roda a MESMA aresta com uma variavel trocada por vez. So isso separa causa de
 * companhia de viagem.
 *
 *  A) ciclo do jogo         — o `Movement` zera a velocidade ao esbarrar e no
 *                             quadro seguinte pede 11,0*4,3/3600 = 1,31 cm
 *  B) pedido constante      — sempre 7,17 cm (4,3 m/s), como se a velocidade
 *                             nunca fosse zerada
 *  C) pedido de 2,1 cm      — logo ACIMA do portao `pedidoH > 0,02` do
 *                             `capsuleSweep`
 *  D) pedido de 1,9 cm      — logo ABAIXO do mesmo portao
 *  E) ciclo do jogo com stepHeight de 0,60 m
 *  F) pedido de 1,31 cm      — o pedido EXATO do quadro seguinte ao esbarrao,
 *                             constante, sem o ciclo de reaceleracao
 *
 * Se B, C e E passam e A, D e F travam, o culpado nao e a altura do degrau: e o
 * PORTAO de 2 cm, que desliga o degrau automatico justamente no quadro em que
 * ele e necessario.
 *
 * ARMADILHA JA PAGA: com orcamento FIXO de 90 quadros os modos de pedido pequeno
 * nunca CHEGAVAM na aresta (1,9 cm x 90 = 1,71 m, e a largada e 1,6 m atras) e o
 * veredito saia "passou" sem que nada tivesse sido exercitado. O orcamento agora
 * e proporcional ao pedido e a corrida so conta como aprovada se o corpo
 * ATRAVESSOU a aresta (campo chegou).
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = process.cwd(), PORT = Number(process.env.PORT ?? 5295);
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const ALVO = { x: Number(arg('x', -25.91)), z: Number(arg('z', -64.01)), rumo: Number(arg('rumo', 182)) };

const vite = spawn(process.execPath, [ROOT + '/node_modules/vite/bin/vite.js', '--config', 'tools/vite.diag.config.js', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r, j) => { const t = setTimeout(() => j(new Error('t/o')), 60000); vite.stdout.on('data', d => { if (/ready in|Local:/i.test(String(d))) { clearTimeout(t); r(); } }); });
const b = await chromium.launch({ headless: true, executablePath: process.env.PW_CHROME || undefined, args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', e => console.log('PAGEERR:', String(e).split('\n')[0]));
await p.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load', timeout: 120000 });
await p.waitForFunction(() => window.__game?.ready, undefined, { timeout: 240000 });
await p.waitForTimeout(800);

const r = await p.evaluate((ALVO) => {
  const ctx = window.__game.ctx, mundo = ctx.world, col = mundo.collision;
  const O = { x: 0, y: 0, z: 0 }, D = { x: 0, y: -1, z: 0 };
  const R = 0.35, H = 1.80;
  const ALTO = (mundo.muralha?.topo ?? mundo.favela.cotaMax + 30) - 1.0;
  const piso = (x, z, deY) => { O.x = x; O.y = deY; O.z = z; const h = col.raycast(O, D, deY - (mundo.favela.cotaMin - 60)); return h.hit ? { y: h.point.y, sup: h.surface } : null; };

  const rad = ALVO.rumo * Math.PI / 180, dx = -Math.sin(rad), dz = -Math.cos(rad);
  const RECUO = 1.6;
  const x0 = ALVO.x - dx * RECUO, z0 = ALVO.z - dz * RECUO;
  const base = piso(x0, z0, ALTO);

  const A = { x: 0, y: 0, z: 0 }, B = { x: 0, y: 0, z: 0 };
  /** `modo`: 'ciclo' reacelera do zero ao esbarrar; numero = pedido fixo (m). */
  const correr = (modo, step) => {
    let px = x0, py = base.y + 0.02, pz = z0, parado = 0, andou = 0, vel = 4.3;
    const trilha = [];
    // orcamento proporcional ao pedido: todo modo tem de poder vencer o recuo
    // inteiro e ainda andar 1,5 m depois da aresta.
    const quadros = modo === 'ciclo' ? 90 : Math.min(1200, Math.ceil((RECUO + 1.5) / modo) + 40);
    for (let k = 0; k < quadros; k++) {
      const passo = modo === 'ciclo' ? vel / 60 : modo;
      A.x = px; A.y = py; A.z = pz;
      B.x = px + dx * passo; B.y = py - 2.0 / 60; B.z = pz + dz * passo;
      const cs = step === undefined ? col.capsuleSweep(A, B, R, H) : col.capsuleSweep(A, B, R, H, step);
      const av = (cs.position.x - px) * dx + (cs.position.z - pz) * dz;
      trilha.push({ k, s: +((cs.position.x - ALVO.x) * dx + (cs.position.z - ALVO.z) * dz).toFixed(3), y: +cs.position.y.toFixed(3), av: +av.toFixed(4), sp: cs.stepped, hw: cs.hitWall, pedido: +passo.toFixed(4) });
      px = cs.position.x; py = cs.position.y; pz = cs.position.z;
      andou += Math.max(0, av);
      if (av < passo * 0.25) { parado++; if (modo === 'ciclo') vel = 11.0 * 4.3 / 60; } else { parado = 0; if (modo === 'ciclo') vel = 4.3; }
      if (parado >= 20) return { travou: true, chegou: false, andou: +andou.toFixed(3), sFinal: +((px - ALVO.x) * dx + (pz - ALVO.z) * dz).toFixed(2), trilha };
    }
    const sF = (px - ALVO.x) * dx + (pz - ALVO.z) * dz;
    return { travou: false, chegou: sF > 0.9, andou: +andou.toFixed(3), sFinal: +sF.toFixed(2), trilha };
  };

  return {
    base: { y: +base.y.toFixed(3), sup: base.sup },
    A: correr('ciclo'),
    B: correr(4.3 / 60),
    C: correr(0.021),
    D: correr(0.019),
    E: correr('ciclo', 0.60),
    F: correr(11.0 * 4.3 / 3600),
  };
}, ALVO);

console.log(`\n  largada em ${JSON.stringify(r.base)}   alvo X=${ALVO.x} Z=${ALVO.z} rumo ${ALVO.rumo}°\n`);
const nomes = {
  A: 'ciclo do jogo (reacelera do zero: pede 1,31 cm)',
  B: 'pedido constante de 7,17 cm (4,3 m/s)',
  C: 'pedido constante de 2,10 cm (acima do portao)',
  D: 'pedido constante de 1,90 cm (abaixo do portao)',
  E: 'ciclo do jogo, mas com stepHeight = 0,60 m',
  F: 'pedido constante de 1,31 cm (abaixo do portao)',
};
for (const k of ['A', 'B', 'C', 'D', 'E', 'F']) {
  const t = r[k];
  const v = t.travou ? 'TRAVOU ' : t.chegou ? 'passou ' : 'INCONCL';
  console.log(`  ${k})  ${nomes[k].padEnd(48)}  ${v}  andou ${String(t.andou).padStart(6)} m   parou em s=${t.sFinal}`);
}

console.log('\n  detalhe do caso A (ciclo do jogo), do quadro em que esbarra:');
console.log('     k       s        Y   avanco  pedido  stepped hitWall');
let visto = 0;
for (const t of r.A.trilha) {
  if (t.av > 0.05 && visto === 0) continue;
  if (visto++ > 16) break;
  console.log(`  ${String(t.k).padStart(4)}${String(t.s).padStart(9)}${String(t.y).padStart(9)}${t.av.toFixed(4).padStart(9)}${t.pedido.toFixed(4).padStart(8)}   ${t.sp ? 'SIM' : ' - '}     ${t.hw ? 'SIM' : ' - '}`);
}
console.log('\n  detalhe do caso B (pedido constante), na mesma regiao:');
console.log('     k       s        Y   avanco  pedido  stepped hitWall');
for (const t of r.B.trilha) {
  if (t.s < -0.6 || t.s > 0.9) continue;
  console.log(`  ${String(t.k).padStart(4)}${String(t.s).padStart(9)}${String(t.y).padStart(9)}${t.av.toFixed(4).padStart(9)}${t.pedido.toFixed(4).padStart(8)}   ${t.sp ? 'SIM' : ' - '}     ${t.hw ? 'SIM' : ' - '}`);
}
await b.close(); vite.kill();
