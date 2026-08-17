// Partida completa COM MORTES: ondas ligadas, jogador parado e imortal que
// "mata" um inimigo a cada poucos segundos (via ctx.ai.damageEnemy, o mesmo
// caminho do tiro real), reinicios de partida no meio, e sondas por segundo em
// TODOS os soldados do pool — vivos e corpos.
//
// Deteccao do "so pernas": para cada soldado visivel, mede vertices skinados
// (peito/cabeca/canela) e a altura do TERRENO no ponto; acusa quando a canela
// esta acima do chao mas o peito esta enterrado, ou quando qualquer sonda
// desloca >1.6 m do esperado num inimigo vivo.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const ROOT = process.cwd(), PORT = parseInt(process.env.PORT ?? '5211', 10);
const MIN_SIM = parseInt(process.env.MIN_SIM ?? '6', 10);
const TAG = process.env.TAG ?? 'mortes';
const OUT = process.env.OUTDIR ?? `${ROOT}/shots/inimigo`;
fs.mkdirSync(OUT, { recursive: true });

const vite = spawn(process.execPath, [ROOT + '/node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort', '--config', ROOT + '/tools/vite.diag.config.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let b;
try {
  await new Promise((r, j) => {
    let o = '';
    const h = d => { o += d; if (/ready in/.test(o)) r(); if (/is in use|EADDRINUSE/.test(o)) j(new Error('porta em uso')); };
    vite.stdout.on('data', h); vite.stderr.on('data', h);
    setTimeout(() => j(new Error('t/o vite')), 40000);
  });
  b = await chromium.launch({ headless: true, args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'] });
  const p = await b.newPage({ viewport: { width: 800, height: 600 } });
  p.on('pageerror', e => console.log('PAGEERR:', e.message.split('\n')[0]));
  await p.addInitScript(() => {
    let s = 777001;
    Math.random = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  });
  await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
  await p.waitForFunction(() => window.__game?.ready, { timeout: 180000 });
  await p.waitForTimeout(2500);
  await p.waitForFunction(() => window.__game?.ready, { timeout: 60000 });

  const res = await p.evaluate(({ minutos }) => {
    const ctx = window.__game.ctx;
    ctx.state = 'pausado';
    const pts = ctx.world.getSpawnPoints();
    const P0 = pts[9].position ?? pts[9];
    ctx.player.movement.teleport(P0.x, P0.y + 0.1, P0.z);
    ctx.player.takeDamage = () => {};
    ctx.ai.reset();
    ctx.ai.spawnAutomatico = true;
    ctx.ai._tOnda = 0;
    ctx.ai.spawnPerto(14);

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
    const _t = new V3(), _o = new V3(), _d = new V3(0, -1, 0);
    const chaoEm = (x, y, z) => {
      const col = ctx.world?.collision;
      if (!col?.raycast) return null;
      _o.set(x, y + 2.5, z);
      const r = col.raycast(_o, _d, 12);
      return r?.hit ? r.point.y : null;
    };

    const sistemas = () => [ctx.player, ctx.ai, ctx.world, ctx.fx, ctx.audio, ctx.sky, ctx.lighting, ctx.postfx, ctx.hud].filter(Boolean);
    const erros = new Map();
    let framesErro = 0, frames = 0;
    const frameSim = (dt) => {
      frames++;
      ctx.state = 'jogando';
      ctx.time.dt = dt; ctx.time.elapsed += dt; ctx.time.frame++;
      try { for (const s of sistemas()) s.update?.(dt, ctx.time.elapsed); }
      catch (e) { framesErro++; const m = (e && e.message) || String(e); erros.set(m, (erros.get(m) ?? 0) + 1); }
      ctx.state = 'pausado';
    };

    // "tiro" do jogador: mata o vivo mais proximo pelo mesmo caminho do jogo
    let mortes = 0;
    const matarUm = () => {
      const jog = ctx.player.position;
      let alvo = null, md = 1e9;
      for (const e of ctx.ai.vivos) {
        if (!e.alive) continue;
        const d = e.pos.distanceTo(jog);
        if (d < md) { md = d; alvo = e; }
      }
      if (!alvo) return;
      const pt = new V3(alvo.pos.x, alvo.pos.y + 1.3, alvo.pos.z);
      ctx.ai.damageEnemy(alvo.id, 250, pt, 'torso', 'ia2');
      mortes++;
    };

    const anom = [];
    const scan = (seg) => {
      for (const e of ctx.ai.pool) {
        const sold = e.soldado;
        // orfa: inativo mas visivel
        if (!e.ativo && sold.grupo.visible) {
          anom.push({ seg, id: e.id, tipo: 'ORFA-VISIVEL', pos: [e.pos.x, e.pos.y, e.pos.z].map(v => +v.toFixed(1)) });
          continue;
        }
        if (!e.ativo || !sold.grupo.visible) continue;
        sold.grupo.updateMatrixWorld(true);
        const S = sondasDe(sold);
        const m = sold.malha;
        const med = {};
        for (const [nome, idx] of Object.entries(S)) {
          m.getVertexPosition(idx, _t);
          m.localToWorld(_t);
          med[nome] = { x: _t.x, y: _t.y, z: _t.z };
        }
        const chao = chaoEm(e.pos.x, e.pos.y, e.pos.z);
        if (e.alive) {
          for (const [nome, esp] of Object.entries(alvos)) {
            const dx = med[nome].x - e.pos.x, dy = med[nome].y - (e.pos.y + esp[1]), dz = med[nome].z - e.pos.z;
            const desloc = Math.hypot(dx, dy, dz);
            if (!Number.isFinite(desloc) || desloc > 1.6) {
              anom.push({ seg, id: e.id, tipo: 'VIVO-DESLOCADO', sonda: nome, desloc: +desloc.toFixed(2), estado: e.estado });
            }
          }
          if (e.morto !== sold.est.morto) anom.push({ seg, id: e.id, tipo: 'MORTO-DESSINCRONIZADO', enemy: e.morto, soldado: sold.est.morto });
        } else if (chao !== null) {
          // corpo: pernas acima do chao com peito enterrado = "pernas saindo do chao"
          const canelaAcima = med.canela.y > chao + 0.12;
          const peitoEnterrado = med.peito.y < chao - 0.15;
          if (canelaAcima && peitoEnterrado) {
            anom.push({ seg, id: e.id, tipo: 'CORPO-PERNAS-PRA-FORA', canelaY: +med.canela.y.toFixed(2), peitoY: +med.peito.y.toFixed(2), chao: +chao.toFixed(2) });
          }
        }
      }
    };

    const log = [];
    const totalSeg = minutos * 60;
    for (let seg = 1; seg <= totalSeg; seg++) {
      for (let f = 0; f < 60; f++) frameSim(1 / 60);
      if (seg % 7 === 0) matarUm();                        // ritmo de tiroteio
      if (seg === Math.floor(totalSeg * 0.5)) {            // reinicio no meio
        ctx.bus?.emit('game:start', {});
        log.push(`t=${seg}s >>> game:start (reinicio)`);
      }
      scan(seg);
      if (seg % 20 === 0) {
        const vivos = ctx.ai.vivos.filter(x => x.alive).length;
        const corpos = ctx.ai.vivos.filter(x => x.morto).length;
        log.push(`t=${String(seg).padStart(3)}s vivos=${vivos} corpos=${corpos} mortes=${mortes} errosFrame=${framesErro} anomalias=${anom.length}`);
      }
    }
    // marca o primeiro anomalo para foto
    const alvoFoto = anom.find(a => a.tipo !== 'MORTO-DESSINCRONIZADO');
    if (alvoFoto) window.__anom = ctx.ai.pool.find(e => e.id === alvoFoto.id) ?? null;
    return { log, frames, framesErro, erros: [...erros.entries()].map(([m, n]) => `${n}x ${m}`), anom: anom.slice(0, 30), mortes, nAnom: anom.length };
  }, { minutos: MIN_SIM });

  console.log('--- partida com mortes ---');
  res.log.forEach(l => console.log(l));
  console.log(`frames=${res.frames} comErro=${res.framesErro} mortes=${res.mortes}`);
  res.erros.forEach(e => console.log('ERRO:', e));
  console.log(`anomalias: ${res.nAnom}`);
  res.anom.forEach(a => console.log(' ', JSON.stringify(a)));

  await p.evaluate(() => {
    const ctx = window.__game.ctx;
    const alvo = window.__anom ?? ctx.ai.vivos.find(x => x.alive);
    if (!alvo) return;
    ctx.camera.up.set(0, 1, 0);
    ctx.camera.position.set(alvo.pos.x + 2.6, alvo.pos.y + 1.5, alvo.pos.z + 2.6);
    ctx.camera.lookAt(alvo.pos.x, alvo.pos.y + 0.9, alvo.pos.z);
    ctx.camera.updateMatrixWorld(true);
    ctx.menu?.hideAll?.(); ctx.hud?.setVisible?.(false); ctx.viewScene.visible = false;
    window.__game.settle(14);
  });
  await p.waitForTimeout(250);
  await p.screenshot({ path: `${OUT}/partida2-${TAG}.png` });
  console.log(`foto: partida2-${TAG}.png`);
} finally {
  await b?.close?.().catch(() => {});
  vite.kill();
}
