/**
 * iblirrad.mjs — le o mapa equiretangular que alimenta o PMREM e calcula a
 * IRRADIANCIA DIFUSA (integral com peso cosseno) para varias normais.
 *
 * Isso responde a pergunta que nenhuma medicao de tela responde direto:
 * a luz que o ceu entrega numa superficie VIRADA PARA CIMA e azul por
 * construcao, ou o caminho do PMREM esta perdendo a parte quente do ceu?
 *
 * Uso: PORT=5200 node tools/iblirrad.mjs [horas...]
 */
import { chromium } from 'playwright';

const PORT = process.env.PORT || 5199;
const HORAS = process.argv.slice(2).map(Number).filter((n) => !Number.isNaN(n));
const LISTA = HORAS.length ? HORAS : [17.5];

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 640, height: 400 } });
p.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));
await p.route('**/@vite/client', (r) => r.abort());
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__game?.ready, null, { timeout: 300000 });
await p.waitForTimeout(1500);

const CFGS = process.env.CFGS ? JSON.parse(process.env.CFGS) : [null];

for (const hora of LISTA) {
 for (const cfg of CFGS) {
  const r = await p.evaluate(async ([h, c]) => {
    const ctx = window.__game.ctx, S = ctx.sky, L = ctx.lighting;
    if (c) {
      if (c.bounce !== undefined) S.bounceStrength = c.bounce;
      if (c.reach !== undefined) S.bounceReach = c.reach;
      if (c.gain !== undefined) S.bounceGain = c.gain;
      if (c.chroma !== undefined) S.lightingChroma = c.chroma;
    }
    S.setTimeOfDay(h);
    S._renderClouds();
    S._renderEnv();
    L._syncFromSky(true);

    const rt = S.envTarget;
    const W = rt.width, H = rt.height;
    const buf = new Uint16Array(W * H * 4);
    ctx.renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);

    // half-float -> float
    const h2f = (u) => {
      const s = (u & 0x8000) ? -1 : 1, e = (u >> 10) & 0x1f, f = u & 0x3ff;
      if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
      if (e === 31) return f ? NaN : s * Infinity;
      return s * Math.pow(2, e - 15) * (1 + f / 1024);
    };

    // Integral com peso cosseno para um conjunto de normais.
    // readRenderTargetPixels devolve a linha 0 embaixo; a UV v=0 do
    // equiretangular do three corresponde a phi = PI (para baixo).
    const normais = {
      cima: [0, 1, 0],
      inclinado30: [0, Math.cos(Math.PI / 6), -Math.sin(Math.PI / 6)],
      parede_norte: [0, 0, -1],
      parede_sul: [0, 0, 1],
      baixo: [0, -1, 0],
    };
    const out = { normais: {}, faixas: {} };
    const acc = {};
    for (const k of Object.keys(normais)) acc[k] = [0, 0, 0, 0];
    // faixas de elevacao, para ver quem carrega energia
    const faixas = { zenite_60_90: [0, 0, 0, 0], meio_20_60: [0, 0, 0, 0], horiz_0_20: [0, 0, 0, 0], abaixo: [0, 0, 0, 0] };

    for (let y = 0; y < H; y++) {
      const v = (y + 0.5) / H;
      const phi = (1 - v) * Math.PI;          // 0 = topo
      const sp = Math.sin(phi), cp = Math.cos(phi);
      const dOmegaBase = sp * (Math.PI / H) * (2 * Math.PI / W);
      for (let x = 0; x < W; x++) {
        const u = (x + 0.5) / W;
        const theta = (u - 0.5) * 2 * Math.PI;
        const dir = [sp * Math.sin(theta), cp, -sp * Math.cos(theta)];
        const k = (y * W + x) * 4;
        const R = h2f(buf[k]), G = h2f(buf[k + 1]), B = h2f(buf[k + 2]);
        for (const [nome, n] of Object.entries(normais)) {
          const c = dir[0] * n[0] + dir[1] * n[1] + dir[2] * n[2];
          if (c <= 0) continue;
          const w = c * dOmegaBase;
          const a = acc[nome]; a[0] += R * w; a[1] += G * w; a[2] += B * w; a[3] += w;
        }
        const el = Math.asin(Math.max(-1, Math.min(1, cp))) * 180 / Math.PI;
        const f = el >= 60 ? faixas.zenite_60_90 : el >= 20 ? faixas.meio_20_60
          : el >= 0 ? faixas.horiz_0_20 : faixas.abaixo;
        // contribuicao para uma normal PARA CIMA
        const w2 = Math.max(0, cp) * dOmegaBase;
        f[0] += R * w2; f[1] += G * w2; f[2] += B * w2; f[3] += w2;
      }
    }
    const fmt = (a) => ({ r: +a[0].toFixed(4), g: +a[1].toFixed(4), b: +a[2].toFixed(4), BsobreR: +(a[2] / Math.max(a[0], 1e-9)).toFixed(2) });
    for (const k of Object.keys(acc)) out.normais[k] = fmt(acc[k]);
    for (const k of Object.keys(faixas)) out.faixas[k] = fmt(faixas[k]);
    out.total = acc.cima[0] + acc.cima[1] + acc.cima[2];
    out.ceu = {
      zenite: S.zenithColor.toArray().map((x) => +x.toFixed(4)),
      horizonte: S.horizonColor.toArray().map((x) => +x.toFixed(4)),
      sol: S.sunColor.toArray().map((x) => +x.toFixed(4)),
      elev: +S.sunElevationDeg.toFixed(1),
    };
    out.cfg = c ? { b: S.bounceStrength, r: S.bounceReach, g: S.bounceGain, c: S.lightingChroma } : 'padrao do codigo';
    return out;
  }, [hora, cfg]);

  console.log(`\n================ ${hora}h  (sol a ${r.ceu.elev} graus)  ${JSON.stringify(r.cfg)} ================`);
  console.log('  zenite   ', JSON.stringify(r.ceu.zenite), ' horizonte', JSON.stringify(r.ceu.horizonte), ' sol', JSON.stringify(r.ceu.sol));
  console.log('\n  IRRADIANCIA (integral cosseno do mapa que vai para o PMREM):');
  for (const [k, v] of Object.entries(r.normais)) {
    console.log('   ' + k.padEnd(14) + `R=${String(v.r).padStart(8)} G=${String(v.g).padStart(8)} B=${String(v.b).padStart(8)}   B/R=${v.BsobreR}`);
  }
  console.log('\n  Quem entrega essa energia numa normal PARA CIMA (por faixa de elevacao):');
  for (const [k, v] of Object.entries(r.faixas)) {
    const pct = (100 * (v.r + v.g + v.b) / Math.max(r.total, 1e-9)).toFixed(1);
    console.log('   ' + k.padEnd(14) + `R=${String(v.r).padStart(8)} G=${String(v.g).padStart(8)} B=${String(v.b).padStart(8)}   B/R=${String(v.BsobreR).padStart(6)}   ${pct}% da energia`);
  }
  const c = r.normais.cima;
  console.log(`\n  RESUMO normal para cima: lum=${(0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b).toFixed(3)}  B/R=${c.BsobreR}`);
 }
}

await b.close();
