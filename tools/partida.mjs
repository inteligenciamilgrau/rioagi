// Reproducao do bug "inimigo so pernas": simula uma PARTIDA REAL por varios
// minutos de tempo simulado, com ondas ligadas e o jogador parado.
//
// Fidelidade ao loop de producao (main.js frame()):
//  - mesma ordem de sistemas (player, ai, world, fx, audio, sky, lighting, postfx, hud)
//  - um throw em ai.update aborta o resto do frame (como no rAF real, que agenda
//    o proximo frame ANTES de rodar frame(), entao o jogo sobrevive ao erro)
//  - render nao roda nos frames que lancaram
//
// Deteccao: a cada segundo simulado mede a POSICAO SKINADA REAL de vertices-sonda
// (peito, cabeca, canela) via mesh.getVertexPosition — o que o rasterizador ve —
// e compara com onde deveriam estar em relacao aos pes do inimigo.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT = process.cwd(), PORT = 5202;
const MIN_SIM = parseInt(process.env.MIN_SIM ?? '5', 10);      // minutos simulados
const TAG = process.env.TAG ?? 'antes';                         // sufixo dos arquivos

const vite = spawn(process.execPath, [ROOT + '/node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r, j) => { let o = ''; const h = d => { o += d; if (/ready in/.test(o)) r(); }; vite.stdout.on('data', h); vite.stderr.on('data', h); setTimeout(() => j(new Error('t/o vite')), 40000); });
const b = await chromium.launch({ headless: true, args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 900, height: 700 } });
p.on('pageerror', e => console.log('PAGEERR:', e.message.split('\n')[0]));
// RNG deterministico ANTES de o jogo carregar: partidas comparaveis antes/depois
await p.addInitScript(() => {
  let s = 1234567;
  Math.random = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
});
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__game?.ready, { timeout: 180000 });
await p.waitForTimeout(1200);

const res = await p.evaluate(({ minutos }) => {
  const ctx = window.__game.ctx;
  ctx.state = 'pausado';

  // jogador parado num spawn valido, imortal (a partida precisa durar minutos)
  const pts = ctx.world.getSpawnPoints();
  const P0 = pts[9].position ?? pts[9];
  ctx.player.movement.teleport(P0.x, P0.y + 0.1, P0.z);
  ctx.player.takeDamage = () => {};   // shadow da instancia, so no harness

  ctx.ai.reset();
  ctx.ai.spawnAutomatico = true;
  ctx.ai._tOnda = 0;
  ctx.ai.spawnPerto(14);

  // ---- vertices-sonda por variante: mais proximo de cada ponto de bind ----
  const alvos = { peito: [0, 1.40, -0.12], cabeca: [0, 1.72, -0.02], canela: [0.103, 0.30, 0.0] };
  const sondasPorVar = new Map();
  const sondasDe = (sold) => {
    const v = sold.variante % 4;
    let s = sondasPorVar.get(v);
    if (s) return s;
    const pos = sold.rec.geo.getAttribute('position');
    s = {};
    for (const [nome, a] of Object.entries(alvos)) {
      let melhor = 0, md = 1e9;
      for (let i = 0; i < pos.count; i++) {
        const dx = pos.getX(i) - a[0], dy = pos.getY(i) - a[1], dz = pos.getZ(i) - a[2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < md) { md = d; melhor = i; }
      }
      s[nome] = melhor;
    }
    sondasPorVar.set(v, s);
    return s;
  };

  const V3 = ctx.camera.position.constructor;
  const _t = new V3();
  const sistemas = () => [ctx.player, ctx.ai, ctx.world, ctx.fx, ctx.audio, ctx.sky, ctx.lighting, ctx.postfx, ctx.hud].filter(Boolean);

  const erros = new Map();       // mensagem -> contagem
  let framesComErro = 0, framesTotais = 0;
  const frameSim = (dt) => {
    framesTotais++;
    ctx.state = 'jogando';
    ctx.time.dt = dt; ctx.time.elapsed += dt; ctx.time.frame++;
    try {
      for (const s of sistemas()) s.update?.(dt, ctx.time.elapsed);
    } catch (e) {
      framesComErro++;
      const m = (e && e.message) || String(e);
      erros.set(m, (erros.get(m) ?? 0) + 1);
    }
    ctx.state = 'pausado';
  };

  const log = [];
  const anomalias = [];
  const tempoAnt = new Map();   // enemyId -> soldado.est.tempo (deteccao de congelado)
  let congeladosMax = 0;

  const scan = (seg) => {
    const estados = {};
    let pior = null;
    for (const e of ctx.ai.vivos) {
      if (!e.alive) continue;
      estados[e.estado] = (estados[e.estado] ?? 0) + 1;

      // congelado? (soldado.update nao rodou no ultimo segundo)
      const t0 = tempoAnt.get(e.id);
      const t1 = e.soldado.est.tempo;
      const congelado = t0 !== undefined && Math.abs(t1 - t0) < 1e-6;
      tempoAnt.set(e.id, t1);

      // posicao skinada real dos vertices-sonda
      const sold = e.soldado;
      sold.grupo.updateMatrixWorld(true);
      const m = sold.malha;
      const S = sondasDe(sold);
      const medida = {};
      let quebra = null;
      for (const [nome, idx] of Object.entries(S)) {
        m.getVertexPosition(idx, _t);
        m.localToWorld(_t);
        const esperado = alvos[nome];
        const dx = _t.x - (e.pos.x), dy = _t.y - (e.pos.y + esperado[1]), dz = _t.z - (e.pos.z);
        const desloc = Math.hypot(dx, dy, dz);
        medida[nome] = { y: +_t.y.toFixed(2), desloc: +desloc.toFixed(2), nan: !Number.isFinite(_t.x + _t.y + _t.z) };
        if (medida[nome].nan || desloc > 1.6) quebra = nome;   // 1.6m tolera animacao/inclinacao
      }
      const zumbi = e.alive && sold.est.morto;
      if (quebra || zumbi || congelado) {
        const reg = { seg, id: e.id, estado: e.estado, congelado, zumbi, quebra, medida, pos: { x: +e.pos.x.toFixed(1), y: +e.pos.y.toFixed(1), z: +e.pos.z.toFixed(1) } };
        anomalias.push(reg);
        if (quebra || zumbi) pior = pior ?? reg;
        if (congelado) congeladosMax++;
      }
    }
    return { estados, pior };
  };

  const totalSeg = minutos * 60;
  let piorGeral = null;
  for (let seg = 1; seg <= totalSeg; seg++) {
    for (let f = 0; f < 60; f++) frameSim(1 / 60);
    const { estados, pior } = scan(seg);
    if (seg % 10 === 0 || pior) {
      log.push(`t=${String(seg).padStart(3)}s vivos=${ctx.ai.vivos.filter(x => x.alive).length} estados=${JSON.stringify(estados)} errosFrame=${framesComErro}`);
    }
    if (pior && !piorGeral) { piorGeral = pior; window.__pior = ctx.ai.vivos.find(x => x.id === pior.id); }
    if (piorGeral && seg >= piorGeral.seg + 2) break;   // 2s extras e para na foto
  }

  return {
    log, framesTotais, framesComErro,
    erros: [...erros.entries()].map(([m, n]) => `${n}x ${m}`),
    anomalias: anomalias.slice(0, 40),
    congeladosMax,
    piorGeral,
  };
}, { minutos: MIN_SIM });

console.log('--- partida simulada ---');
res.log.forEach(l => console.log(l));
console.log(`frames=${res.framesTotais} comErro=${res.framesComErro}`);
res.erros.forEach(e => console.log('ERRO:', e));
console.log(`anomalias registradas: ${res.anomalias.length} (congelamentos acumulados: ${res.congeladosMax})`);
res.anomalias.slice(0, 12).forEach(a => console.log(' ', JSON.stringify(a)));
if (res.piorGeral) console.log('>>> PIOR:', JSON.stringify(res.piorGeral));

// foto do pior inimigo (ou aerea da area do jogador, se nada quebrou)
await p.evaluate(() => {
  const ctx = window.__game.ctx;
  const alvo = window.__pior ?? ctx.ai.vivos.find(x => x.alive);
  if (!alvo) return;
  ctx.camera.up.set(0, 1, 0);
  ctx.camera.position.set(alvo.pos.x + 2.6, alvo.pos.y + 1.5, alvo.pos.z + 2.6);
  ctx.camera.lookAt(alvo.pos.x, alvo.pos.y + 0.9, alvo.pos.z);
  ctx.camera.updateMatrixWorld(true);
  ctx.menu?.hideAll?.(); ctx.hud?.setVisible?.(false); ctx.viewScene.visible = false;
  window.__game.settle(14);
});
await p.waitForTimeout(250);
await p.screenshot({ path: `${ROOT}/shots/inimigo/partida-${TAG}.png` });
console.log(`foto: shots/inimigo/partida-${TAG}.png`);
await b.close(); vite.kill();
