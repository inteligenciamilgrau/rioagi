/**
 * Fotometro do robo: mede a COR DE PIXEL da maquina DENTRO do jogo, em luz de
 * dia, a 5/15/30 m — em pleno sol e em sombra aberta — e no estudio, que e o
 * alvo a bater.
 *
 *   node tools/roboCor.mjs             jogo (sol + sombra) + estudio
 *   node tools/roboCor.mjs --decomp    soma a decomposicao da luz (env/hemi/sol)
 *
 * TRES cuidados que a primeira versao deste arquivo nao tinha, e sem os quais o
 * numero mente:
 *
 *  1. A silhueta e isolada renderizando a MESMA camera duas vezes, com e sem a
 *     malha, e ficando com os pixels que mudaram (erodidos 1 px, para nao pegar
 *     borda anti-aliased). Nao depende de croma nem de fundo.
 *  2. A pose e feita na mao (sem AIManager). Se a IA rodar, o robo anda e cada
 *     medicao recorta uma silhueta diferente.
 *  3. `sky.update` e `lighting.update` sao CONGELADOS depois do boot. O laco de
 *     rAF continua rodando entre um evaluate e outro; com as nuvens andando e o
 *     IBL sendo regerado, a mesma configuracao media 30% diferente no comeco e
 *     no fim da bateria. Toda comparacao entre configuracoes acontece DENTRO de
 *     um unico evaluate, sem rAF no meio.
 *
 * So imprime numeros; nao sobrescreve captura nenhuma.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const ROOT = process.cwd(), PORT = 5199;
const DECOMP = process.argv.includes('--decomp');

const vite = spawn(process.execPath, [
  ROOT + '/node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT),
  '--strictPort', '--config', ROOT + '/tools/vite.diag.config.js',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r, j) => {
  let o = ''; const h = (d) => { o += d; if (/ready in/.test(o)) r(); };
  vite.stdout.on('data', h); vite.stderr.on('data', h);
  setTimeout(() => j(new Error('timeout do vite')), 40000);
});

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});

/* ===================================================================== *
 * Rotinas de medicao injetadas na pagina
 * ===================================================================== */
const LIB = `
window.__cor = {
  ler(canvas) {
    const cv = document.createElement('canvas');
    cv.width = canvas.width; cv.height = canvas.height;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(canvas, 0, 0);
    return g.getImageData(0, 0, cv.width, cv.height);
  },
  /**
   * Silhueta = pixels que mudaram entre A (com robo) e B (sem robo), MAS:
   *   - so dentro de cx (a caixa do robo projetada dos ossos). Sem isso o
   *     rastro de TAA e o halo de bloom espalham pontos por toda a tela e, a
   *     15/30 m, esses pontos sao a MAIORIA da amostra — a medicao vira lixo.
   *   - erodida 1 px (mata a borda anti-aliased, que mistura com o fundo).
   *   - so a maior componente conexa (mata o que sobrou solto).
   */
  mascara(A, B, lim = 10, cx = null) {
    const w = A.width, h = A.height, a = A.data, b = B.data;
    const X0 = cx ? Math.max(1, cx[0]) : 1, Y0 = cx ? Math.max(1, cx[1]) : 1;
    const X1 = cx ? Math.min(w - 2, cx[2]) : w - 2, Y1 = cx ? Math.min(h - 2, cx[3]) : h - 2;
    const m = new Uint8Array(w * h);
    for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) {
      const p = y * w + x, i = p * 4;
      const d = Math.max(Math.abs(a[i]-b[i]), Math.abs(a[i+1]-b[i+1]), Math.abs(a[i+2]-b[i+2]));
      m[p] = d > lim ? 1 : 0;
    }
    // A 30 m o robo tem ~7 px de largura: erodir apaga a amostra inteira.
    const erodir = (Y1 - Y0) > 46;
    const e = new Uint8Array(w * h);
    for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) {
      const p = y * w + x;
      e[p] = erodir ? ((m[p] && m[p-1] && m[p+1] && m[p-w] && m[p+w]) ? 1 : 0) : m[p];
    }
    // maior componente conexa (4-vizinhos)
    const marca = new Int32Array(w * h).fill(-1);
    const pilha = new Int32Array(w * h);
    let melhorId = -1, melhorN = 0, id = 0;
    for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) {
      const p0 = y * w + x;
      if (!e[p0] || marca[p0] >= 0) continue;
      let topo = 0, n = 0; pilha[topo++] = p0; marca[p0] = id;
      while (topo > 0) {
        const p = pilha[--topo]; n++;
        const px = p % w, py = (p - px) / w;
        if (px > X0 && e[p-1] && marca[p-1] < 0) { marca[p-1] = id; pilha[topo++] = p-1; }
        if (px < X1 && e[p+1] && marca[p+1] < 0) { marca[p+1] = id; pilha[topo++] = p+1; }
        if (py > Y0 && e[p-w] && marca[p-w] < 0) { marca[p-w] = id; pilha[topo++] = p-w; }
        if (py < Y1 && e[p+w] && marca[p+w] < 0) { marca[p+w] = id; pilha[topo++] = p+w; }
      }
      if (n > melhorN) { melhorN = n; melhorId = id; }
      id++;
    }
    const f = new Uint8Array(w * h);
    if (melhorId >= 0) for (let p = 0; p < w * h; p++) f[p] = marca[p] === melhorId ? 1 : 0;
    return { m: f, w, h };
  },
  ciano(R, G, Bv) { return (G + Bv) / 2 - R; },
  stats(A, msk) {
    const a = A.data, m = msk.m, w = msk.w, h = msk.h;
    const corpo = [], optica = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x; if (!m[p]) continue;
      const i = p * 4, R = a[i], G = a[i+1], Bv = a[i+2];
      (this.ciano(R, G, Bv) > 34 && Bv > 90) ? optica.push(R, G, Bv) : corpo.push(R, G, Bv);
    }
    return { corpo: this.resumo(corpo), optica: this.resumo(optica) };
  },
  resumo(arr) {
    const n = arr.length / 3;
    if (!n) return { n: 0, r: 0, g: 0, b: 0, lum: 0, p10: 0, p50: 0, p90: 0, frio: 0 };
    let R = 0, G = 0, Bv = 0; const L = new Float64Array(n);
    for (let k = 0, j = 0; k < arr.length; k += 3, j++) {
      R += arr[k]; G += arr[k+1]; Bv += arr[k+2];
      L[j] = 0.2126 * arr[k] + 0.7152 * arr[k+1] + 0.0722 * arr[k+2];
    }
    L.sort();
    const pct = (q) => L[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))];
    return {
      n, r: +(R/n).toFixed(1), g: +(G/n).toFixed(1), b: +(Bv/n).toFixed(1),
      lum: +((0.2126*R + 0.7152*G + 0.0722*Bv) / n).toFixed(1),
      p10: +pct(0.10).toFixed(0), p50: +pct(0.50).toFixed(0), p90: +pct(0.90).toFixed(0),
      frio: +((Bv - R) / n).toFixed(1),
    };
  },
  /** Legibilidade da fenda numa janela em volta da cabeca (coords de canvas). */
  fenda(A, cx, cy, raio) {
    const a = A.data, w = A.width, h = A.height;
    const x0 = Math.max(0, cx - raio), x1 = Math.min(w - 1, cx + raio);
    const y0 = Math.max(0, cy - raio), y1 = Math.min(h - 1, cy + raio);
    let maxCi = -999, nCi = 0, sLc = 0, sLf = 0, nf = 0, mr = 0, mg = 0, mb = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = (y * w + x) * 4, R = a[i], G = a[i+1], Bv = a[i+2];
      const ci = this.ciano(R, G, Bv);
      const L = 0.2126*R + 0.7152*G + 0.0722*Bv;
      if (ci > maxCi) { maxCi = ci; mr = R; mg = G; mb = Bv; }
      if (ci > 22) { nCi++; sLc += L; } else { sLf += L; nf++; }
    }
    return {
      maxCiano: +maxCi.toFixed(1), pico: [mr, mg, mb], nCiano: nCi,
      lumCiano: nCi ? +(sLc / nCi).toFixed(1) : 0,
      lumFundo: nf ? +(sLf / nf).toFixed(1) : 0,
    };
  },
};

/** Caixa do robo na tela, projetada dos 22 ossos + margem. */
window.__caixaRobo = function (S, cam, w, h) {
  const V = S.grupo.position.constructor;
  const v = new V();
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  S.grupo.updateWorldMatrix(true, true);
  for (const bn of S.esqueleto.bones) {
    v.setFromMatrixPosition(bn.matrixWorld).project(cam);
    const sx = (v.x * 0.5 + 0.5) * w, sy = (-v.y * 0.5 + 0.5) * h;
    if (sx < x0) x0 = sx; if (sx > x1) x1 = sx;
    if (sy < y0) y0 = sy; if (sy > y1) y1 = sy;
  }
  const mx = Math.max(6, (x1 - x0) * 0.55), my = Math.max(6, (y1 - y0) * 0.18);
  return [Math.round(x0 - mx), Math.round(y0 - my), Math.round(x1 + mx), Math.round(y1 + my)];
};

/** Mede UM robo (variante v) numa posicao, com a camera no olho dado. */
window.__medirRobo = function (S, alvo, olho, ctx, larguraJanela) {
  S.grupo.visible = true;
  S.grupo.position.set(alvo.x, alvo.y, alvo.z);
  S.grupo.rotation.set(0, Math.atan2(olho.x - alvo.x, olho.z - alvo.z), 0);
  S.setLocomocao(0, 0, false);
  S.setMira(olho, 1);
  S.setPoseArma('mira');
  for (let i = 0; i < 50; i++) S.update(1 / 60);

  ctx.camera.up.set(0, 1, 0);
  ctx.camera.position.copy(olho);
  ctx.camera.lookAt(alvo.x, alvo.y + 1.25, alvo.z);
  ctx.camera.updateMatrixWorld(true);

  window.__game.settle(24);
  const A = window.__cor.ler(ctx.renderer.domElement);
  const caixa = window.__caixaRobo(S, ctx.camera, A.width, A.height);
  S.grupo.visible = false;
  window.__game.settle(24);
  const B = window.__cor.ler(ctx.renderer.domElement);
  S.grupo.visible = true;

  const st = window.__cor.stats(A, window.__cor.mascara(A, B, 10, caixa));
  const pr = S.posOlho().clone().project(ctx.camera);
  const cx = Math.round((pr.x * 0.5 + 0.5) * A.width);
  const cy = Math.round((-pr.y * 0.5 + 0.5) * A.height);
  return { ...st, caixa, fenda: window.__cor.fenda(A, cx, cy, larguraJanela) };
};
`;

const fmt = (rot, c, f) =>
  `  ${rot.padEnd(26)} rgb(${String(c.r).padStart(5)},${String(c.g).padStart(5)},${String(c.b).padStart(5)}) `
  + `lum=${String(c.lum).padStart(5)} p50/p90=${String(c.p50).padStart(3)}/${String(c.p90).padStart(3)} `
  + `frio=${String(c.frio).padStart(6)} n=${String(c.n).padStart(5)}`
  + ` | fenda pico=${String(f.maxCiano).padStart(6)} n=${String(f.nCiano).padStart(4)} C/F=${f.lumCiano}/${f.lumFundo}`;

/* ===================================================================== *
 * 1) ESTUDIO — o alvo
 * ===================================================================== */
const pe = await b.newPage({ viewport: { width: 900, height: 900 } });
pe.setDefaultTimeout(300000);
pe.on('pageerror', (e) => console.log('ERR-estudio:', e.message.split('\n')[0]));
await pe.goto(`http://127.0.0.1:${PORT}/tools/robo.html`, { waitUntil: 'load', timeout: 60000 });
await pe.waitForFunction(() => window.__robo?.pronto, { timeout: 60000 });
await pe.evaluate(LIB);

const estudio = await pe.evaluate(() => {
  const R = window.__robo, out = [];
  for (let v = 0; v < 3; v++) {
    R.montar(1, 1.15, [v]); R.luzAmbiente(1);
    const s = R.soldados[0];
    s.setLocomocao(0, 0, false); s.setMira(null, 0); s.setPoseArma('pronto');
    R.passo(1 / 60, 90);
    R.olhar(3.0, 1.10, 0, 1.05);
    R.desenhar();
    const A = window.__cor.ler(R.renderer.domElement);
    const caixa = window.__caixaRobo(s, R.camera, A.width, A.height);
    s.grupo.visible = false; R.desenhar();
    const B = window.__cor.ler(R.renderer.domElement);
    s.grupo.visible = true;
    const st = window.__cor.stats(A, window.__cor.mascara(A, B, 10, caixa));
    const p = s.posOlho().clone().project(R.camera);
    const cx = Math.round((p.x * 0.5 + 0.5) * R.renderer.domElement.width);
    const cy = Math.round((-p.y * 0.5 + 0.5) * R.renderer.domElement.height);
    out.push({ v, ...st, fenda: window.__cor.fenda(A, cx, cy, 45) });
  }
  return out;
});
console.log('\n############ ESTUDIO (tools/robo.html) — o ALVO ############');
for (const e of estudio) console.log(fmt(`var ${e.v} @3m`, e.corpo, e.fenda));
await pe.close();

/* ===================================================================== *
 * 2) JOGO
 * ===================================================================== */
const p = await b.newPage({ viewport: { width: 1000, height: 720 } });
p.setDefaultTimeout(300000);
p.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));
p.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text().slice(0, 160)); });
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__game?.ready, { timeout: 240000 });
await p.waitForTimeout(1500);
await p.evaluate(LIB);

const palcos = await p.evaluate(() => {
  const ctx = window.__game.ctx;
  ctx.state = 'pausado';
  ctx.ai.spawnAutomatico = false;
  ctx.menu?.hideAll?.(); ctx.hud?.setVisible?.(false); ctx.viewScene.visible = false;
  // CONGELA ceu e luz: nada pode mudar entre uma configuracao e outra.
  ctx.lighting.update = () => {};
  ctx.sky.update = () => {};
  for (const e of ctx.ai.pool) { e.ativo = false; e.soldado.grupo.visible = false; }
  ctx.ai.vivos.length = 0;

  const T = ctx.camera.position.constructor;
  const sol = ctx.lighting.sunDirection.clone();
  const col = ctx.world.collision;
  const pts = ctx.world.getSpawnPoints();
  const noSol = (x, y, z) => !col.raycast(new T(x, y + 1.2, z), sol, 90)?.hit;
  const chao = (x, z, yRef) => {
    const r = col.raycast(new T(x, yRef + 4, z), new T(0, -1, 0), 12);
    return r?.hit ? r.point.y : null;
  };
  const procurar = (querSol) => {
    for (let i = 0; i < pts.length; i++) {
      const q = pts[i].position ?? pts[i];
      for (let g = 0; g < 24; g++) {
        const yaw = (g / 24) * Math.PI * 2;
        const dx = Math.sin(yaw), dz = -Math.cos(yaw);
        let ok = true; const alvos = [];
        for (const d of [5, 15, 30]) {
          const x = q.x + dx * d, z = q.z + dz * d;
          const y = chao(x, z, q.y);
          if (y === null || Math.abs(y - q.y) > 3.0) { ok = false; break; }
          if (noSol(x, y, z) !== querSol) { ok = false; break; }
          alvos.push({ d, x, y, z });
        }
        if (!ok) continue;
        const olho = new T(q.x, q.y + 1.68, q.z);
        const a30 = alvos[2];
        const dir = new T(a30.x - olho.x, (a30.y + 1.0) - olho.y, a30.z - olho.z);
        const dist = dir.length(); dir.normalize();
        if (col.raycast(olho, dir, dist - 0.7)?.hit) continue;
        return { spawn: i, yawDeg: +(yaw * 180 / Math.PI).toFixed(0), base: { x: q.x, y: q.y, z: q.z }, alvos };
      }
    }
    return null;
  };
  window.__palcos = { sol: procurar(true), sombra: procurar(false) };
  return {
    sol: window.__palcos.sol, sombra: window.__palcos.sombra,
    dirSol: { x: +sol.x.toFixed(3), y: +sol.y.toFixed(3), z: +sol.z.toFixed(3) },
    envInt: ctx.scene.environmentIntensity,
    matEnv: ctx.ai.pool[0].soldado.malha.material.envMapIntensity,
    hemi: ctx.lighting.hemi.intensity,
    sun: ctx.lighting.lights.map((l) => +l.intensity.toFixed(2)),
    expo: ctx.postfx?.exposureScale, bloom: ctx.postfx?.bloomThreshold,
  };
});
console.log('\n############ PALCOS / ESTADO DA LUZ ############');
console.log('  sol dir:', JSON.stringify(palcos.dirSol),
  ' scene.environmentIntensity =', palcos.envInt,
  ' material.envMapIntensity =', palcos.matEnv);
console.log('  hemi =', palcos.hemi, ' cascatas do sol =', JSON.stringify(palcos.sun),
  ' exposureScale =', palcos.expo, ' bloomThreshold =', palcos.bloom);
console.log('  pleno sol:', palcos.sol ? `spawn ${palcos.sol.spawn} yaw ${palcos.sol.yawDeg}` : 'NAO ACHOU');
console.log('  sombra   :', palcos.sombra ? `spawn ${palcos.sombra.spawn} yaw ${palcos.sombra.yawDeg}` : 'NAO ACHOU');
if (!palcos.sol) { await b.close(); vite.kill(); process.exit(1); }

/**
 * Uma bateria = UM evaluate. Todas as configuracoes sao medidas em sequencia,
 * sem rAF no meio, entao a unica coisa que muda entre elas e a configuracao.
 */
const bateria = async (palco, dists, configs) => {
  const r = await p.evaluate((arg) => {
    const ctx = window.__game.ctx;
    const T = ctx.camera.position.constructor;
    const pl = window.__palcos[arg.palco];
    if (!pl) return null;
    const olho = new T(pl.base.x, pl.base.y + 1.68, pl.base.z);
    const mat = ctx.ai.pool[0].soldado.malha.material;
    const est = {
      envCena: ctx.scene.environmentIntensity, envMat: mat.envMapIntensity,
      hemi: ctx.lighting.hemi.intensity, sun: ctx.lighting.lights.map((l) => l.intensity),
      envTex: ctx.scene.environment,
    };

    const restaurar = () => {
      ctx.scene.environmentIntensity = est.envCena; mat.envMapIntensity = est.envMat;
      ctx.lighting.hemi.intensity = est.hemi;
      ctx.lighting.lights.forEach((l, i) => { l.intensity = est.sun[i]; });
      ctx.scene.environment = est.envTex;
      // sem isto as configuracoes do sweep se ACUMULAM e o controle nao fecha
    };
    const saida = [];
    for (const cfg of arg.configs) {
      restaurar();
      if (cfg.js) new Function('ctx', 'mat', cfg.js)(ctx, mat);
      for (const alvo of pl.alvos) {
        if (!arg.dists.includes(alvo.d)) continue;
        for (let v = 0; v < 3; v++) {
          const S = ctx.ai.pool.find((x) => x.soldado.variante === v).soldado;
          for (const o of ctx.ai.pool) o.soldado.grupo.visible = false;
          S.reviver();
          const raio = Math.max(7, Math.round(150 / alvo.d));
          saida.push({ cfg: cfg.nome, d: alvo.d, v, ...window.__medirRobo(S, alvo, olho, ctx, raio) });
        }
      }
    }
    restaurar();
    for (const e of ctx.ai.pool) e.soldado.grupo.visible = false;
    return saida;
  }, { palco, dists, configs });
  if (!r) { console.log('  (palco indisponivel)'); return null; }
  let ultimo = null;
  for (const l of r) {
    if (l.cfg !== ultimo) { console.log(`  -- ${l.cfg} --`); ultimo = l.cfg; }
    console.log(fmt(`${String(l.d).padStart(2)}m v${l.v}`, l.corpo, l.fenda));
  }
  return r;
};

/* Os botoes de calibracao do material foram assados em constantes depois da
 * medicao (custavam 0.66 ms/quadro). Para uma nova rodada, reintroduza-os em
 * materialSoldado() e volte a listar as configuracoes aqui. */
const CFG_BASE = [{ nome: 'como esta', js: '' }];
const CFG_DECOMP = [
  { nome: 'como esta', js: '' },
  { nome: 'material.envMapIntensity = 0 (tira o IBL SO do robo)', js: 'mat.envMapIntensity = 0;' },
  { nome: 'scene.environment = null (tira o IBL da cena toda)', js: 'ctx.scene.environment = null;' },
  { nome: 'sem hemisferica', js: 'ctx.lighting.hemi.intensity = 0;' },
  { nome: 'sem sol (so ceu/IBL)', js: 'for (const l of ctx.lighting.lights) l.intensity = 0;' },
  { nome: 'controle (tem de bater com a primeira)', js: '' },
];

console.log('\n############ JOGO — PLENO SOL ############');
await bateria('sol', [5, 15, 30], DECOMP ? CFG_DECOMP : CFG_BASE);
console.log('\n############ JOGO — SOMBRA ABERTA ############');
await bateria('sombra', [5, 15, 30], DECOMP ? CFG_DECOMP : CFG_BASE);

console.log('\nok');
await b.close();
vite.kill();
