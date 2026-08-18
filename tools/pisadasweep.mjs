/**
 * pisadasweep.mjs — grampo no `capsuleSweep`: quadro a quadro, o que a colisao
 * devolveu (stepped / grounded / hitWall) enquanto o jogador cruza o ponto.
 *
 * Sem isto, so se ve a consequencia (o Y pulando) e nao a causa (qual ramo do
 * `capsuleSweep` disparou). Tambem mede o mesmo trecho em varios rumos e
 * deslocamentos laterais, porque uma linha so pode passar entre dois defeitos.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const ROOT = process.cwd(), PORT = Number(process.env.PORT ?? 5293);
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

const r = await p.evaluate(async (ALVO) => {
  const ctx = window.__game.ctx, jog = ctx.player, mundo = ctx.world, col = mundo.collision;
  ctx.state = 'jogando';

  /* Grampo: envolve capsuleSweep para anotar o resultado de cada quadro. O
   * objeto devolvido e SEMPRE o mesmo, entao os campos sao copiados na hora. */
  const bruto = col.capsuleSweep.bind(col);
  let reg = null;
  col.capsuleSweep = (s, e, ra, h, st) => {
    const out = bruto(s, e, ra, h, st);
    if (reg) reg.push({
      sy: +s.y.toFixed(3), ey: +e.y.toFixed(3),
      py: +out.position.y.toFixed(3), g: out.grounded, sp: out.stepped, hw: out.hitWall,
      pedido: +Math.hypot(e.x - s.x, e.z - s.z).toFixed(4),
      obtido: +Math.hypot(out.position.x - s.x, out.position.z - s.z).toFixed(4),
      sup: out.surface,
    });
    return out;
  };

  /** Uma travessia: larga `recuo` m antes do alvo, com deslocamento lateral. */
  const travessia = (rumoGrau, lateral, agachado, recuo = 5, seg = 4) => {
    const rad = rumoGrau * Math.PI / 180, dx = -Math.sin(rad), dz = -Math.cos(rad);
    // perpendicular ao rumo
    const px0 = ALVO.x - dz * lateral, pz0 = ALVO.z + dx * lateral;
    const px = px0 - dx * recuo, pz = pz0 - dz * recuo;
    jog.destravar?.();
    jog.movement.teleport(px, mundo.heightAt(px, pz) + 1.2, pz);
    jog.movement.velocity.set(0, 0, 0);
    jog.rig.reset(rad, 0);                        // o vetor de andar e relativo ao YAW
    for (let i = 0; i < 80; i++) jog.update(1 / 60);

    const orig = ctx.input.getMoveVector.bind(ctx.input);
    const origD = ctx.input.isDown?.bind(ctx.input);
    ctx.input.getMoveVector = (out) => { out.x = 0; out.y = 1; return out; };
    if (agachado && origD) ctx.input.isDown = (a) => (a === 'crouch' ? true : origD(a));
    ctx.input.locked = true;

    reg = [];
    const quadros = [];
    let ax = jog.position.x, az = jog.position.z, ay = jog.position.y;
    const PEDIDO = 4.3 / 60;
    for (let i = 0; i < 60 * seg; i++) {
      reg.length = 0;
      jog.update(1 / 60);
      const q = jog.position, mv = jog.movement;
      const proj = (q.x - ax) * dx + (q.z - az) * dz;
      const dy = q.y - ay;
      // o sweep principal do quadro e o ultimo registrado (mantle/canstand usam raycast)
      const s = reg.length ? reg[reg.length - 1] : null;
      quadros.push({
        i, s: +((q.x - ALVO.x) * dx + (q.z - ALVO.z) * dz).toFixed(3),
        y: +q.y.toFixed(3), dy: +dy.toFixed(3), proj: +proj.toFixed(4),
        v: +Math.hypot(mv.velocity.x, mv.velocity.z).toFixed(2), g: mv.grounded,
        st: s ? s.sp : null, hw: s ? s.hw : null, sg: s ? s.g : null,
      });
      ax = q.x; az = q.z; ay = q.y;
    }
    ctx.input.getMoveVector = orig;
    if (origD) ctx.input.isDown = origD;
    reg = null;

    // so a janela util: -3 a +3 m do alvo, e depois da aceleracao inicial
    const janela = quadros.filter((f) => f.i > 15 && f.s > -3 && f.s < 3);
    let pulo = 0, puloEm = null, travados = 0, minV = 99, steps = 0, noAr = 0;
    for (const f of janela) {
      if (f.dy > pulo) { pulo = f.dy; puloEm = f.s; }
      if (f.proj < PEDIDO * 0.25) travados++;
      if (f.v < minV) minV = f.v;
      if (f.st) steps++;
      if (!f.g) noAr++;
    }
    return {
      rumo: rumoGrau, lateral, agachado,
      puloY: +pulo.toFixed(3), puloEm: puloEm === null ? null : +puloEm.toFixed(2),
      travados, minV: +minV.toFixed(2), steps, noAr,
      avanco: +(janela.length ? janela[janela.length - 1].s - janela[0].s : 0).toFixed(2),
      quadros: (rumoGrau === ALVO.rumo && lateral === 0 && !agachado) ? janela : null,
    };
  };

  const saidas = [];
  // o rumo relatado, e o inverso (subir a calcada em vez de descer)
  for (const rumo of [ALVO.rumo, (ALVO.rumo + 180) % 360]) {
    for (const lat of [-1.5, -0.75, 0, 0.75, 1.5]) saidas.push(travessia(rumo, lat, false));
  }
  saidas.push(travessia(ALVO.rumo, 0, true));
  saidas.push(travessia((ALVO.rumo + 180) % 360, 0, true));

  col.capsuleSweep = bruto;
  return { saidas };
}, ALVO);

console.log('\n=== travessias do ponto (janela de -3 a +3 m) =========================');
console.log('  rumo  lateral  agach   avanco  puloY max   em s    travados  minV  steps  noAr');
for (const s of r.saidas) {
  const alerta = s.puloY > 0.10 || s.travados > 0 ? '   <<<' : '';
  console.log(`  ${String(s.rumo).padStart(4)}°${String(s.lateral).padStart(8)}   ${s.agachado ? 'sim' : ' - '}`
    + `${String(s.avanco).padStart(9)}${String(s.puloY).padStart(11)}${String(s.puloEm).padStart(8)}`
    + `${String(s.travados).padStart(11)}${String(s.minV).padStart(7)}${String(s.steps).padStart(7)}${String(s.noAr).padStart(6)}${alerta}`);
}

const detalhe = r.saidas.find((s) => s.quadros);
if (detalhe) {
  console.log('\n=== quadro a quadro no rumo relatado (dy = salto do olho no quadro) ===');
  console.log('   quadro       s        Y       dy   avanco    vel  noChao  stepped  hitWall');
  for (const f of detalhe.quadros) {
    if (f.s < -1.2 || f.s > 2.0) continue;
    const m = Math.abs(f.dy) > 0.05 ? '   <<<' : '';
    console.log(`  ${String(f.i).padStart(7)}${String(f.s).padStart(8)}${String(f.y).padStart(9)}${String(f.dy).padStart(9)}`
      + `${f.proj.toFixed(3).padStart(9)}${String(f.v).padStart(7)}   ${f.g ? 'sim' : 'NAO'}     ${f.st ? 'SIM' : ' - '}      ${f.hw ? 'SIM' : ' - '}${m}`);
  }
}

if (SAIDA) { writeFileSync(SAIDA, JSON.stringify(r, null, 1)); console.log('\n  json em ' + SAIDA); }
await b.close(); vite.kill();
