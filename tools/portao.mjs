/**
 * portao.mjs — no quadro em que o pe prende, QUAL das cinco condicoes do degrau
 * automatico reprova. Nao reconstroi a conta por fora: instrumenta o
 * `capsuleSweep` de verdade e le o caminho pela SEQUENCIA de chamadas dos
 * metodos privados.
 *
 * Ramo do degrau em `Collision.capsuleSweep`, com o numero de cada portao:
 *   1. pedidoH > 0,02                          houve pedido de andar
 *   2. obtidoH < pedidoH * 0,85                o plano barrou
 *   3. _depenetrate(start + stepHeight) == 0   cabe la em cima
 *   4. obtidoB > obtidoH + 0,005               de cima anda mais que no plano
 *   5. _sondaChao(B.pos, r, step+0,25) achou, e
 *      start.y - 0,6 <= sonda.y <= start.y + step + 0,02
 *
 * Como se le o caminho (sem obstaculo movel; `passos` = sub-passos da marcha):
 *   dep == passos                      -> parou no portao 1 ou 2
 *   dep == passos+1 (a ultima > 0)     -> portao 3
 *   dep == 2*passos+1, sem sonda 0,70  -> portao 4
 *   sonda 0,70 presente, fora da faixa -> portao 5
 *   `stepped` verdadeiro               -> subiu
 *
 * O teste roda a MESMA aresta com pedidos de tamanho crescente, a partir do
 * estado congelado do quadro travado. E assim que se separa "o portao de 2 cm
 * desliga o degrau" de "o degrau liga e mesmo assim nao resolve".
 *
 * Uso: node tools/portao.mjs [--x -25.91] [--z -64.01] [--rumo 182] [--json f]
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const ROOT = process.cwd(), PORT = Number(process.env.PORT ?? 5298);
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const ALVO = { x: Number(arg('x', -25.91)), z: Number(arg('z', -64.01)), rumo: Number(arg('rumo', 182)) };
const SAIDA = arg('json', null);

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
  const R = 0.35, H = 1.80, STEP = 0.45;
  const ALTO = (mundo.muralha?.topo ?? mundo.favela.cotaMax + 30) - 1.0;
  const FUNDO = mundo.favela.cotaMin - 60;
  const piso = (x, z, deY) => { O.x = x; O.y = deY; O.z = z; const h = col.raycast(O, D, deY - FUNDO); return h.hit ? { y: h.point.y, sup: h.surface, ny: h.normal.y } : null; };

  const rad = ALVO.rumo * Math.PI / 180, dx = -Math.sin(rad), dz = -Math.cos(rad);

  /* --- grampo: guarda a sequencia de chamadas de UM quadro --- */
  const depOrig = col._depenetrate.bind(col);
  const sonOrig = col._sondaChao.bind(col);
  let log = null;
  col._depenetrate = (pos, radius, height, normalOut) => {
    const n = depOrig(pos, radius, height, normalOut);
    if (log) log.dep.push(n);
    return n;
  };
  col._sondaChao = (pos, radius, alcance, res) => {
    const ok = sonOrig(pos, radius, alcance, res);
    if (log) log.son.push({ alc: +alcance.toFixed(2), ok, y: ok ? +res.y.toFixed(3) : null, py: +pos.y.toFixed(3) });
    return ok;
  };

  const A = { x: 0, y: 0, z: 0 }, B = { x: 0, y: 0, z: 0 };
  /** Um quadro instrumentado. Devolve o portao em que o ramo do degrau parou. */
  const quadro = (px, py, pz, passo) => {
    A.x = px; A.y = py; A.z = pz;
    B.x = px + dx * passo; B.y = py - 2.0 / 60; B.z = pz + dz * passo;
    const pedidoH = passo;
    const passos = Math.min(12, Math.max(1, Math.ceil(Math.hypot(dx * passo, -2 / 60, dz * passo) / (R * 0.5))));
    log = { dep: [], son: [] };
    const cs = col.capsuleSweep(A, B, R, H);
    const g = log; log = null;
    const av = (cs.position.x - px) * dx + (cs.position.z - pz) * dz;
    const sonda70 = g.son.find((s) => s.alc > 0.5);
    let portao;
    if (cs.stepped) portao = 0;
    else if (pedidoH <= 1e-4) portao = 1;   // acompanhe o piso real do Collision
    else if (g.dep.length <= passos) portao = 2;
    else if (g.dep.length === passos + 1) portao = 3;
    else if (!sonda70) portao = 4;
    else portao = 5;
    return {
      passo: +passo.toFixed(4), av: +av.toFixed(4), y: +cs.position.y.toFixed(3),
      stepped: cs.stepped, hitWall: cs.hitWall, grounded: cs.grounded,
      portao, passos, nDep: g.dep.length,
      sonda70: sonda70 ? { y: sonda70.y, ok: sonda70.ok, de: sonda70.py } : null,
      faixa: [+(py - 0.6).toFixed(3), +(py + STEP + 0.02).toFixed(3)],
      pos: { x: +cs.position.x.toFixed(3), z: +cs.position.z.toFixed(3) },
    };
  };

  /* --- 1) anda ate travar, com o ciclo do jogo --- */
  const RECUO = 1.6;
  let px = ALVO.x - dx * RECUO, pz = ALVO.z - dz * RECUO;
  const base = piso(px, pz, ALTO);
  let py = base.y + 0.02, vel = 4.3, parado = 0;
  const caminho = [];
  for (let k = 0; k < 120; k++) {
    const q = quadro(px, py, pz, vel / 60);
    caminho.push({ k, s: +((q.pos.x - ALVO.x) * dx + (q.pos.z - ALVO.z) * dz).toFixed(3), ...q });
    px = q.pos.x; py = q.y; pz = q.pos.z;
    if (q.av < (vel / 60) * 0.25) { parado++; vel = 11.0 * 4.3 / 60; } else { parado = 0; vel = 4.3; }
    if (parado >= 12) break;
  }

  /* --- 2) do estado travado, varre o tamanho do pedido --- */
  const escada = [];
  for (const passo of [0.005, 0.0131, 0.019, 0.021, 0.03, 0.05, 0.0717, 0.10, 0.15, 0.20, 0.30]) {
    escada.push(quadro(px, py, pz, passo));
  }

  /* --- 2b) o degrau nao pode COMER o pulo ---
   * O ramo do degrau POUSA o corpo. Se rodar com a capsula subindo, ele cancela
   * o pulo — e o defeito antigo de "as vezes pula, as vezes nao", que o
   * `Collision` ja tratava na sonda final e nao tratava no ramo do degrau.
   * Aqui a capsula sobe a 4,65 m/s (o pulo do `Movement`) encostada na MESMA
   * aresta: tem de ganhar altura e nao pode voltar grudada no chao. */
  const pulo = [];
  {
    let jy = py, jvy = Math.sqrt(2 * 9.81 * 1.10);
    for (let k = 0; k < 8; k++) {
      const passo = 4.3 / 60;
      A.x = px; A.y = jy; A.z = pz;
      B.x = px + dx * passo; B.y = jy + jvy / 60; B.z = pz + dz * passo;
      const cs = col.capsuleSweep(A, B, R, H);
      pulo.push({ k, y: +cs.position.y.toFixed(3), ganho: +(cs.position.y - jy).toFixed(3), grounded: cs.grounded, stepped: cs.stepped });
      jy = cs.position.y; jvy -= 9.81 / 60;
    }
  }

  /* --- 3) o que ha a frente, medido de cima --- */
  const aqui = piso(px, pz, ALTO);
  const perfil = [];
  for (const d of [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.50, 0.60, 0.80]) {
    const f = piso(px + dx * d, pz + dz * d, ALTO);
    perfil.push({ d, y: f ? +f.y.toFixed(3) : null, sobe: f && aqui ? +(f.y - aqui.y).toFixed(3) : null, sup: f ? f.sup : null, ny: f ? +f.ny.toFixed(2) : null });
  }

  col._depenetrate = depOrig; col._sondaChao = sonOrig;
  return {
    base: { y: +base.y.toFixed(3), sup: base.sup },
    travado: { x: +px.toFixed(3), y: +py.toFixed(3), z: +pz.toFixed(3) },
    aqui, caminho, escada, perfil, pulo, dx: +dx.toFixed(3), dz: +dz.toFixed(3),
  };
}, ALVO);

const NOMES = {
  0: 'SUBIU (stepped)',
  1: 'portao 1: piso de pedido REPROVOU',
  2: 'portao 2: obtidoH < 0,85*pedidoH REPROVOU (o plano nao barrou)',
  3: 'portao 3: nao cabe em pe no ponto elevado',
  4: 'portao 4: de cima nao anda mais que no plano',
  5: 'portao 5: patamar ausente ou fora da faixa',
};
console.log('\n  alvo X=' + ALVO.x + ' Z=' + ALVO.z + ' rumo ' + ALVO.rumo + '   largada ' + JSON.stringify(r.base));
console.log('  travou em X=' + r.travado.x + ' Y=' + r.travado.y + ' Z=' + r.travado.z + '\n');

console.log('  perfil do chao a frente (raio de cima para baixo):');
console.log('     d(m)      Y     sobe   ny   sup');
for (const q of r.perfil) console.log('   ' + String(q.d).padStart(6) + String(q.y).padStart(9) + String(q.sobe).padStart(9) + String(q.ny).padStart(6) + '   ' + q.sup);

console.log('\n  ultimos quadros da marcha (ciclo do jogo):');
console.log('     k       s     pedido  avanco       Y  portao');
for (const q of r.caminho.slice(-14)) {
  console.log('  ' + String(q.k).padStart(4) + String(q.s).padStart(9) + q.passo.toFixed(4).padStart(11) + q.av.toFixed(4).padStart(8) + String(q.y).padStart(9) + '  ' + NOMES[q.portao]);
}

console.log('\n  do MESMO estado travado, variando so o tamanho do pedido:');
console.log('    pedido   avanco       Y    sonda70   faixa aceita           veredito');
for (const q of r.escada) {
  const s70 = q.sonda70 ? (q.sonda70.ok ? String(q.sonda70.y) : 'nao achou') : '-';
  console.log('  ' + q.passo.toFixed(4).padStart(8) + q.av.toFixed(4).padStart(9) + String(q.y).padStart(8) + String(s70).padStart(11) + '  [' + q.faixa[0] + '..' + q.faixa[1] + ']  ' + NOMES[q.portao]);
}
console.log('\n  pulo encostado na mesma aresta (o degrau nao pode comer o pulo):');
for (const q of r.pulo) console.log('   k=' + q.k + '  Y=' + q.y + '  ganho ' + q.ganho + '  grounded=' + q.grounded + '  stepped=' + q.stepped);

if (SAIDA) { writeFileSync(SAIDA, JSON.stringify(r, null, 1)); console.log('\n  json em ' + SAIDA); }
await b.close(); vite.kill();
