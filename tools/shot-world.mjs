/**
 * Tira fotos do banco de teste do WORLD (test/world.html) com Playwright.
 * Uso: node tools/shot-world.mjs [porta] [pasta]
 * Nao faz parte do jogo — e ferramenta de verificacao do agente WORLD.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const PORTA = process.argv[2] || '5199';
const PASTA = process.argv[3] || 'shots';
const URL = `http://127.0.0.1:${PORTA}/test/world.html`;

mkdirSync(PASTA, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PW_CHROME || undefined,   // sem PW_CHROME, Playwright resolve sozinha
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(180000);
page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

console.log('abrindo', URL);
await page.goto(URL, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__pronto === true, null, { timeout: 180000 });

await page.evaluate(() => window.__pausar());
const stats = await page.evaluate(() => window.__stats());
console.log('STATS', JSON.stringify(stats.mundo));

/** Acha camaras interessantes lendo o plano da favela direto da pagina. */
const poses = await page.evaluate(() => {
  const w = window.__world, f = w.favela;
  const out = [];
  const terr = (x, z) => w.collision.groundAt(x, z, 200);

  // 1) dentro de um beco estreito, olhando ao longo dele
  const becos = f.vias.filter((v) => v.tipo === 'beco' && v.w < 2.0 && v.pts.length > 14);
  becos.sort((a, b) => a.w - b.w);
  for (const v of becos.slice(0, 3)) {
    const i = Math.floor(v.pts.length * 0.35);
    const p = v.pts[i], pn = v.pts[i + 4] || v.pts[v.pts.length - 1];
    out.push({
      nome: `beco${Math.round(v.w*10)}`,
      pos: [p[0], terr(p[0], p[1]) + 1.68, p[1]],
      alvo: [pn[0], terr(pn[0], pn[1]) + 1.5, pn[1]],
      fov: 75,
    });
  }
  // 2) olhando uma escadaria de baixo para cima
  for (const v of f.vias) {
    if (!v.lances || !v.lances.length) continue;
    const [i0, i1] = v.lances[0];
    if (i1 - i0 < 6) continue;
    const a = v.pts[Math.max(0, i0 - 3)], b = v.pts[i1];
    const ya = terr(a[0], a[1]), yb = terr(b[0], b[1]);
    if (yb < ya) continue;
    out.push({
      nome: 'escadaria',
      pos: [a[0], ya + 1.68, a[1]],
      alvo: [b[0], yb + 1.2, b[1]],
      fov: 75,
    });
    break;
  }
  // 3) na rua principal, olhando o morro subir
  const rua = f.vias[0];
  const pr = rua.pts[Math.floor(rua.pts.length * 0.12)];
  const pr2 = rua.pts[Math.floor(rua.pts.length * 0.24)];
  out.push({
    nome: 'rua',
    pos: [pr[0], terr(pr[0], pr[1]) + 1.68, pr[1]],
    alvo: [pr2[0], terr(pr2[0], pr2[1]) + 3.5, pr2[1]],
    fov: 78,
  });
  // 4) tunel (passagem por baixo de casa) — o eixo do vao e o X local da casa
  for (const tun of f.casas.filter((c) => c.tunel).slice(0, 2)) {
    const yaw = tun.yaw;
    const dx = Math.cos(yaw), dz = -Math.sin(yaw);
    const px = tun.x - dx * 8, pz = tun.z - dz * 8;
    out.push({
      nome: 'tunel',
      pos: [px, terr(px, pz) + 1.68, pz],
      alvo: [tun.x + dx * 6, terr(tun.x, tun.z) + 1.6, tun.z + dz * 6],
      fov: 78,
    });
  }
  // 4b) escadaria de perto, de lado (para conferir o degrau)
  for (const v of f.vias) {
    if (!v.lances || !v.lances.length) continue;
    const [i0, i1] = v.lances[v.lances.length - 1];
    if (i1 - i0 < 8) continue;
    const meio = v.pts[Math.floor((i0 + i1) / 2)];
    const a = v.pts[i0];
    out.push({
      nome: 'escada-perto',
      pos: [meio[0] + 4.5, terr(meio[0], meio[1]) + 2.6, meio[1] + 4.5],
      alvo: [a[0], terr(a[0], a[1]) + 1.0, a[1]],
      fov: 60,
    });
    break;
  }
  // 5) praça / botequim
  if (f.pracas[0]) {
    const p = f.pracas[0];
    const px = p.x + p.r + 3, pz = p.z + p.r + 3;
    out.push({
      nome: 'praca',
      pos: [px, terr(px, pz) + 1.7, pz],
      alvo: [p.x, terr(p.x, p.z) + 1.6, p.z],
      fov: 75,
    });
  }
  // 6) campinho
  const cp = f.campinho;
  out.push({
    nome: 'campinho',
    pos: [cp.x - cp.w * 0.7, terr(cp.x - cp.w * 0.7, cp.z) + 2.4, cp.z + cp.d * 0.75],
    alvo: [cp.x + 6, terr(cp.x, cp.z) + 2, cp.z],
    fov: 72,
  });
  // 7) em cima de uma laje alta
  const lajes = w.buildings.ancoras.lajes.slice().sort((a, b) => b.y - a.y);
  if (lajes[8]) {
    const L = lajes[8];
    out.push({
      nome: 'laje',
      pos: [L.x, L.y + 1.7, L.z],
      alvo: [L.x * 0.2, L.y - 3, L.z * 0.2 + 20],
      fov: 78,
    });
  }
  return out;
});

const FIXAS = [
  { nome: '00-aerea', pos: [0, 150, 152], alvo: [0, 14, -6], fov: 55 },
  { nome: '01-aerea-baixa', pos: [70, 74, 86], alvo: [-10, 18, -14], fov: 48 },
  { nome: '02-encosta', pos: [-84, 52, 60], alvo: [8, 20, -18], fov: 44 },
  { nome: '03-rasante', pos: [40, 26, 62], alvo: [-16, 14, -4], fov: 40 },
];

let i = 0;
for (const c of [...FIXAS, ...poses.map((p, k) => ({ ...p, nome: `${10 + k}-${p.nome}` }))]) {
  await page.evaluate(([pos, alvo, fov]) => window.__pose(pos, alvo, fov), [c.pos, c.alvo, c.fov]);
  await page.waitForTimeout(120);
  const s = await page.evaluate(() => window.__stats());
  await page.screenshot({ path: `${PASTA}/${c.nome}.png` });
  console.log(`${c.nome.padEnd(22)} draw=${String(s.drawCalls).padStart(4)}  tris=${(s.triangulos / 1000).toFixed(0)}k`);
  i++;
}

// wireframe da vista aerea
await page.evaluate(() => window.__pose([0, 130, 130], [0, 14, -6], 55));
await page.evaluate(() => window.__wire(true));
await page.waitForTimeout(300);
await page.screenshot({ path: `${PASTA}/90-wireframe.png` });
await page.evaluate(() => window.__wire(false));

// overlay de navGrid
await page.evaluate(() => { window.__overlay('nav', true); window.__pose([0, 120, 120], [0, 12, -6], 55); });
await page.waitForTimeout(300);
await page.screenshot({ path: `${PASTA}/91-navgrid.png` });
await page.evaluate(() => window.__overlay('nav', false));

// luz plana: julgar geometria sem contraste de entardecer
await page.evaluate(() => { window.__overlay('nav', false); window.__luzPlana(true); window.__pose([28, 22, 58], [-6, 12, 6], 48); });
await page.waitForTimeout(200);
await page.screenshot({ path: `${PASTA}/93-luz-plana.png` });
await page.evaluate(() => window.__luzPlana(false));

// overlay de cobertura + spawn
await page.evaluate(() => { window.__overlay('cobertura', true); window.__overlay('spawn', true); });
await page.waitForTimeout(300);
await page.screenshot({ path: `${PASTA}/92-cobertura-spawn.png` });

const fim = await page.evaluate(() => window.__stats());
console.log('\nFINAL', JSON.stringify({ draw: fim.drawCalls, tris: fim.triangulos, nav: fim.navAndavel }, null, 1));
console.log(`${i + 3} imagens em ${PASTA}/`);
await browser.close();
