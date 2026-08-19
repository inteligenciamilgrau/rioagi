/**
 * lod.mjs — QUANTO VALE CADA ALAVANCA, medido no mesmo minuto.
 *
 * A bancada e ruidosa: o p99 do mesmo binario ja variou de 24 a 104 ms conforme
 * a carga externa (NOTES [CORE] secao 6). Comparar duas CORRIDAS aqui nao prova
 * nada. Entao esta ferramenta INTERCALA as condicoes dentro da MESMA corrida,
 * varias voltas, com o mesmo campo e o mesmo piloto — e compara condicao contra
 * condicao usando so as voltas vizinhas.
 *
 * Condicoes (aplicadas de fora, sem editar o jogo — isto e sonda, nao remendo):
 *   base          nada mudado
 *   cull          `frustumCulled = true` no corpo/arma do hostil e no drone,
 *                 com esfera envolvente generosa escrita a mao
 *   sombraLonge   `castShadow = false` alem de N metros
 *   animLenta     `Soldier.update` a 1/3 do ritmo alem de N metros
 *   raioLento     sonda de voo do drone e sonda de chao do hostil a 1/3 alem de N
 *   tudo          as quatro juntas
 *
 * O que ela responde: qual delas paga o quadro, e quanto. Sem isso a correcao
 * vira palpite.
 *
 * Uso:  node tools/lod.mjs            VOLTAS=5 SEG=5 CHAO=12 DRONE=6
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 5313);
const VOLTAS = Number(process.env.VOLTAS ?? 5);
const SEG = Number(process.env.SEG ?? 5);
const CHAO = Number(process.env.CHAO ?? 12);
const DRONE = Number(process.env.DRONE ?? 6);
const DIST = Number(process.env.DIST ?? 26);
const TAG = process.env.TAG ?? 'lod';

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
    '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERR:', String(e).split('\n')[0]));

await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready, undefined, { timeout: 300000 });
await page.mouse.click(640, 360);
await page.waitForTimeout(1200);

const aferi = await page.evaluate(({ DIST }) => {
  const ctx = window.__game.ctx;
  const R = ctx.renderer;
  const jog = ctx.player;
  window.__dano = 0;
  if (!jog.__blindado) {
    const orig = jog.takeDamage.bind(jog);
    jog.takeDamage = (d) => { window.__dano += d; return jog.health; };
    jog.__blindado = orig;
  }
  jog.alive = true; jog.health = jog.maxHealth;

  const T = Object.create(null);
  const env = (obj, m, n) => {
    if (!obj || typeof obj[m] !== 'function' || obj['__e_' + m]) return;
    const o = obj[m]; obj['__e_' + m] = true;
    obj[m] = function (...a) {
      const t0 = performance.now();
      try { return o.apply(this, a); } finally { T[n] = (T[n] || 0) + (performance.now() - t0); }
    };
  };
  const ai = ctx.ai;
  const protoSold = Object.getPrototypeOf(ai.poolSolo[0].soldado);
  env(ctx.engine, 'render', 'render');
  env(Object.getPrototypeOf(ai), 'update', 'ai');
  env(ctx.player, 'update', 'player');
  env(protoSold, 'update', 'anim');
  env(Object.getPrototypeOf(ai.poolDrone[0]), '_mover', 'voo');

  let raios = 0;
  const col = ctx.world.collision;
  for (const m of ['raycast', 'sphereCast', 'capsuleSweep']) {
    const o = col[m].bind(col);
    col[m] = (...a) => { raios++; return o(...a); };
  }

  /* ---- as alavancas, aplicadas de fora ---- */
  const S = { cull: false, sombra: false, anim: false, raio: false };
  const V3 = ctx.camera.position.constructor;
  const Esfera = new (Object.getPrototypeOf(ctx.scene).constructor === Object ? Object : Object)();
  void Esfera;

  // esfera envolvente escrita a mao: a do bind do SkinnedMesh nao acompanha o
  // esqueleto, entao ela e generosa de proposito (1,6 m de raio num boneco de 1,8)
  const prepararCull = () => {
    for (const e of ai.poolSolo) {
      const m = e.soldado.malha, a = e.soldado.arma;
      if (!m.__esfOK) {
        m.geometry.computeBoundingSphere();
        m.boundingSphere = m.geometry.boundingSphere.clone();
        m.boundingSphere.center.set(0, 0.9, 0);
        m.boundingSphere.radius = 1.6;
        m.__esfOK = true;
      }
      void a;
    }
  };
  prepararCull();

  const aplicar = () => {
    const cam = ctx.camera.position;
    for (const e of ai.poolSolo) {
      const s = e.soldado;
      s.malha.frustumCulled = S.cull;
      s.arma.frustumCulled = S.cull;
      if (S.sombra) {
        const longe = e.pos.distanceTo(cam) > DIST;
        s.malha.castShadow = !longe;
        s.arma.castShadow = !longe;
      } else { s.malha.castShadow = true; s.arma.castShadow = true; }
    }
    for (const d of ai.poolDrone) {
      d.corpo.frustumCulled = S.cull;
      d.corpo.castShadow = S.sombra ? d.pos.distanceTo(cam) <= DIST : true;
    }
  };

  /* animLenta: pula 2 de cada 3 chamadas de `Soldier.update` para quem esta
   * longe. E sonda, nao correcao — mede o teto do ganho. */
  const origAnim = protoSold.update;
  let quadro = 0;
  protoSold.update = function (dt) {
    if (S.anim && this.__longe && (quadro + (this.__ord | 0)) % 3 !== 0) return;
    return origAnim.call(this, dt);
  };
  /* raioLento: derruba as sondas de voo do drone e a sonda de chao do hostil
   * para 1/3 do ritmo quando o agente esta longe. */
  const protoDrone = Object.getPrototypeOf(ai.poolDrone[0]);
  const origVoo = protoDrone._mover;
  protoDrone._mover = function (dt) {
    if (S.raio && this.__longe && (quadro + (this.__ord | 0)) % 3 !== 0) {
      this.pos.addScaledVector(this.vel, dt);
      this._pose?.(dt);
      return;
    }
    return origVoo.call(this, dt);
  };

  window.__lod = {
    S, T, cond: 'base', rodando: false, Q: [],
    marcar(c) { this.cond = c; },
    setar(c) {
      S.cull = c === 'cull' || c === 'tudo';
      S.sombra = c === 'sombraLonge' || c === 'tudo';
      S.anim = c === 'animLenta' || c === 'tudo';
      S.raio = c === 'raioLento' || c === 'tudo';
      this.cond = c;
    },
  };

  let ant = performance.now();
  const passo = () => {
    const t = performance.now(); const dt = t - ant; ant = t;
    quadro++;
    const cam = ctx.camera.position;
    let i = 0;
    for (const e of ai.poolSolo) { e.soldado.__longe = e.pos.distanceTo(cam) > DIST; e.soldado.__ord = i++; }
    i = 0;
    for (const d of ai.poolDrone) { d.__longe = d.pos.distanceTo(cam) > DIST; d.__ord = i++; }
    aplicar();
    const L = window.__lod;
    if (L.rodando) {
      let vivos = 0, drones = 0;
      for (const e of ai.vivos) { if (!e.alive) continue; vivos++; if (e.eDrone) drones++; }
      L.Q.push([L.cond, +dt.toFixed(3), +(T.render || 0).toFixed(3), +(T.ai || 0).toFixed(3),
        +(T.player || 0).toFixed(3), +(T.anim || 0).toFixed(3), +(T.voo || 0).toFixed(3),
        R.info.render.calls, R.info.render.triangles, raios, vivos, drones]);
    }
    for (const k in T) T[k] = 0;
    raios = 0;
    L.piloto?.();
    requestAnimationFrame(passo);
  };
  requestAnimationFrame(passo);
  return { cascatas: ctx.lighting?.cascades ?? 0, preset: ctx.settings?.q?.name ?? '?' };
}, { DIST });

/* --- piloto: o mesmo do miolo.mjs --- */
await page.evaluate(({ CHAO, DRONE }) => {
  const ctx = window.__game.ctx;
  const inp = ctx.input; const jog = ctx.player;
  inp.locked = true; ctx.settings.set?.('musicVolume', 0.2);
  const V = ctx.camera.position.constructor; const dirTmp = new V();
  let t = 0, fase = 0, tRepor = 0;
  window.__lod.piloto = () => {
    t += 1 / 60; fase += 1 / 60;
    const ws = jog.weapons;
    if (ws && ws.reserve < 30) ws.slots[ws.index].reserve = 300;
    if (ws && ws.ammo === 0 && !ws.reloading) inp._pressedThisFrame.add('KeyR');
    tRepor -= 1 / 60;
    if (tRepor <= 0) {
      tRepor = 1.5;
      let vs = 0, vd = 0;
      for (const e of ctx.ai.vivos) { if (!e.alive) continue; if (e.eDrone) vd++; else vs++; }
      if (vs < CHAO) ctx.ai.spawnOnda(CHAO - vs, 13, 42, 'solo');
      if (vd < DRONE) ctx.ai.spawnOnda(DRONE - vd, 15, 42, 'drone');
      ctx.ai.convergirNoJogador(1.1);
    }
    let alvo = null, melhor = 1e9;
    for (const e of ctx.ai.vivos) {
      if (!e.alive) continue;
      const d = e.pos.distanceToSquared(jog.position);
      if (d < melhor) { melhor = d; alvo = e; }
    }
    const rig = jog.rig; const sens = ctx.settings?.sensitivity ?? 0.0022;
    if (alvo && rig) {
      dirTmp.subVectors(alvo.pos, jog.eyePosition);
      if (!alvo.eDrone) dirTmp.y += 1.1;
      const yawAlvo = Math.atan2(-dirTmp.x, -dirTmp.z);
      const pitchAlvo = Math.atan2(dirTmp.y, Math.hypot(dirTmp.x, dirTmp.z));
      let d = yawAlvo - rig.yaw;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      const dp = pitchAlvo - rig.pitch; const pm = 0.075;
      inp.mouseDX = -Math.max(-pm, Math.min(pm, d * 0.22)) / sens;
      inp.mouseDY = -Math.max(-pm, Math.min(pm, dp * 0.22)) / sens;
      inp.buttons[0] = Math.hypot(d, dp) < 0.10 && Math.sqrt(melhor) < 55 && !!ws && ws.ammo > 0;
      inp.buttons[2] = Math.hypot(d, dp) < 0.25 && Math.sqrt(melhor) > 18;
    } else { inp.mouseDX = 0.9 / sens * 0.02; inp.buttons[0] = false; inp.buttons[2] = false; }
    const c = fase % 8;
    inp.keys.delete('KeyA'); inp.keys.delete('KeyD'); inp.keys.delete('ShiftLeft'); inp.keys.delete('KeyC');
    inp.keys.add('KeyW');
    if (c < 2.5) inp.keys.add('ShiftLeft');
    else if (c < 4) inp.keys.add('KeyA');
    else if (c < 5.5) inp.keys.add('KeyD');
    else if (c < 6.5) inp.keys.add('KeyC');
    if (Math.abs(c - 7.0) < 1 / 60) inp._pressedThisFrame.add('Space');
  };
  ctx.menu?.hideAll?.();
  ctx.state = 'jogando';
  ctx.bus.emit('game:start', {});
  if (ctx.progressao) ctx.progressao.fase = 'fim';
  ctx.ai.spawnAutomatico = false;
  ctx.ai.maxVivos = CHAO + DRONE;
  ctx.ai.maxDrones = DRONE;
  ctx.ai.maxAtiradores = 4;
  ctx.ai.spawnOnda(CHAO, 13, 42, 'solo');
  ctx.ai.spawnOnda(DRONE, 15, 42, 'drone');
  ctx.ai.convergirNoJogador(1.2);
}, { CHAO, DRONE });

await page.waitForTimeout(9000);   // campo enche e converge antes de gravar
await page.evaluate(() => { window.__lod.rodando = true; });

const COND = ['base', 'cull', 'sombraLonge', 'animLenta', 'raioLento', 'tudo'];
process.stdout.write('medindo');
for (let v = 0; v < VOLTAS; v++) {
  for (const c of COND) {
    await page.evaluate((c) => window.__lod.setar(c), c);
    await page.waitForTimeout(600);                     // descarta a transicao
    await page.evaluate(() => { window.__lod.cond = window.__lod.S.__nome || window.__lod.cond; });
    await page.waitForTimeout(SEG * 1000);
    process.stdout.write('.');
  }
}
console.log('');

const bruto = await page.evaluate(() => {
  window.__lod.rodando = false;
  return { Q: window.__lod.Q, dano: window.__dano };
});
await browser.close();
vite.kill();

/* --------------------------------- analise -------------------------------- */
const Q = bruto.Q.filter((r) => r[10] >= (CHAO + DRONE) * 0.6);   // so campo cheio
const por = new Map();
for (const r of Q) {
  if (!por.has(r[0])) por.set(r[0], []);
  por.get(r[0]).push(r);
}
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const med = (a) => pct(a, 0.5);
const n2 = (x) => (isFinite(x) ? x.toFixed(2) : '-');

console.log('');
console.log('=========================================================================');
console.log('ALAVANCAS — mesma corrida, ' + VOLTAS + ' voltas de ' + SEG + ' s, ' + CHAO + ' de chao + ' + DRONE + ' drones');
console.log('=========================================================================');
console.log('  preset ' + aferi.preset + ', ' + aferi.cascatas + ' cascatas de sombra · corte de distancia ' + DIST + ' m');
console.log('');
console.log('  condicao       quadros | render p50  p99 | anim p50 | voo p50 | ai p50 | dt p50   p99 | draws | raios');
const base = por.get('base') || [];
const linha = (c) => {
  const S = por.get(c); if (!S?.length) return;
  const g = (i) => S.map((r) => r[i]);
  console.log('  ' + c.padEnd(14) + String(S.length).padStart(6) + ' |'
    + n2(med(g(2))).padStart(11) + n2(pct(g(2), 0.99)).padStart(6) + ' |'
    + n2(med(g(5))).padStart(9) + ' |' + n2(med(g(6))).padStart(8) + ' |'
    + n2(med(g(3))).padStart(7) + ' |' + n2(med(g(1))).padStart(7) + n2(pct(g(1), 0.99)).padStart(7) + ' |'
    + String(Math.round(med(g(7)))).padStart(6) + ' |' + String(Math.round(med(g(9)))).padStart(6));
};
for (const c of COND) linha(c);

console.log('');
console.log('  ganho contra `base` (mediana, ms por quadro):');
const bR = med(base.map((r) => r[2])), bA = med(base.map((r) => r[3]));
const bAn = med(base.map((r) => r[5])), bV = med(base.map((r) => r[6]));
const bD = med(base.map((r) => r[7])), bRa = med(base.map((r) => r[9]));
for (const c of COND.slice(1)) {
  const S = por.get(c); if (!S?.length) continue;
  const g = (i) => S.map((r) => r[i]);
  console.log('    ' + c.padEnd(14)
    + 'render ' + (med(g(2)) - bR >= 0 ? '+' : '') + n2(med(g(2)) - bR)
    + '   anim ' + (med(g(5)) - bAn >= 0 ? '+' : '') + n2(med(g(5)) - bAn)
    + '   voo ' + (med(g(6)) - bV >= 0 ? '+' : '') + n2(med(g(6)) - bV)
    + '   ai ' + (med(g(3)) - bA >= 0 ? '+' : '') + n2(med(g(3)) - bA)
    + '   draws ' + Math.round(med(g(7)) - bD)
    + '   raios ' + Math.round(med(g(9)) - bRa));
}

writeFileSync(ROOT + '/tools/' + TAG + '.json', JSON.stringify({ aferi, Q: bruto.Q }));
console.log('');
console.log('  dump: tools/' + TAG + '.json   ·  dano tomado ' + Math.round(bruto.dano));
