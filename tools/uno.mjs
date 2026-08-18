/**
 * Fotografa o Fiat Uno com escada (e, para comparar, o fusca) no banco de teste
 * do WORLD. Acha os veiculos por window.__world.props.posVeiculos e escolhe a
 * camera por RAYCAST: numa favela a maioria das posicoes cai dentro de casa.
 * Uso: node tools/uno.mjs [porta]
 * Nao faz parte do jogo — e ferramenta de verificacao do agente WORLD.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || 5194);
const PASTA = path.join(ROOT, 'shots');
mkdirSync(PASTA, { recursive: true });

const vite = spawn(process.execPath,
  // config de diagnostico: HMR desligado, para outro agente salvando um arquivo
  // no meio da medicao nao recarregar a pagina e derrubar os ganchos.
  [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1',
    '--port', String(PORT), '--strictPort', '--config', path.join(ROOT, 'tools/vite.diag.config.js')],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((res, rej) => {
  let o = ''; const h = (d) => { o += d; if (/ready in/.test(o)) res(); };
  vite.stdout.on('data', h); vite.stderr.on('data', h);
  setTimeout(() => rej(new Error('timeout vite')), 60000);
});

const browser = await chromium.launch({
  headless: true,
  // Sem PW_CHROME definido, deixa a propria Playwright resolver o Chromium.
  executablePath: process.env.PW_CHROME || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(240000);
const erros = [];
page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) { erros.push(m.text()); console.log('[console]', m.text()); } });
page.on('pageerror', (e) => { erros.push(e.message); console.log('[pageerror]', e.message); });

await page.goto(`http://127.0.0.1:${PORT}/world.html`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__pronto === true, null, { timeout: 240000 });
await page.evaluate(() => {
  window.__pausar();
  // esconde os paineis de depuracao: eles tapam um terco do quadro
  for (const id of ['hud', 'ajuda']) { const e = document.getElementById(id); if (e) e.style.display = 'none'; }
});

const veic = await page.evaluate(() => window.__world.props.posVeiculos);
console.log('veiculos:', JSON.stringify(veic.map((v) => ({ t: v.tipo, x: +v.x.toFixed(1), z: +v.z.toFixed(1) }))));

/**
 * Varre um anel de posicoes em volta do veiculo e devolve as que tem linha de
 * visada livre ate o teto do carro. ang = 0 e a frente, 90 e o lado +Z local.
 */
async function candidatos(v, alvoLocal) {
  return page.evaluate(([veh, alvo]) => {
    const col = window.__world.collision;
    const V = window.__three.camera.position.constructor;
    const c = Math.cos(veh.yaw), s = Math.sin(veh.yaw);
    const loc = (lx, lz) => [veh.x + lx * c + lz * s, veh.z - lx * s + lz * c];
    const [ax, az] = loc(alvo[0], alvo[2]);
    const ay = veh.y + alvo[1];
    const vOrg = new V(), vDir = new V();
    const out = [];
    for (let a = 0; a < 360; a += 10) {
      const rad = a * Math.PI / 180;
      for (const dist of [5, 6.5, 8, 10]) {
        for (const alt of [1.35, 1.65, 2.4]) {
          const [cx, cz] = loc(Math.cos(rad) * dist, Math.sin(rad) * dist);
          // altura medida a partir do CHAO DO CARRO, nao do chao sob a camera:
          // a rua e em ladeira e o "nivel do olho" local desenquadra o perfil.
          const cy = veh.y + alt;
          if (!isFinite(cy)) continue;
          // a favela e em ladeira: rejeita camera enterrada no morro. De dentro
          // do terreno o raycast sai limpo e a foto vem do avesso do mundo.
          const solo = col.groundAt(cx, cz, 200);
          if (!isFinite(solo) || solo > cy - 0.5) continue;
          vOrg.set(cx, cy, cz);
          vDir.set(ax - cx, ay - cy, az - cz);
          const d = vDir.length(); vDir.normalize();
          const h = col.raycast(vOrg, vDir, d);
          // 2.6 m: pode bater no proprio carro/escada, nao em parede antes dele
          const livre = !h?.hit || h.distance > d - 2.6;
          if (livre) out.push({ ang: a, dist, alt, cam: [cx, cy, cz], alvo: [ax, ay, az] });
        }
      }
    }
    return out;
  }, [v, alvoLocal]);
}

/** Melhor candidato perto de um angulo alvo, preferindo mais longe e mais baixo. */
function melhor(lista, angAlvo, prefAlt) {
  let best = null, bs = -1e9;
  for (const c of lista) {
    const d = Math.abs(((c.ang - angAlvo + 540) % 360) - 180);   // 0 = na direcao certa
    const score = -d * 3 + c.dist * 1.2 - Math.abs(c.alt - prefAlt) * 2.5;
    if (score > bs) { bs = score; best = c; }
  }
  return best;
}

const uno = veic.find((v) => v.tipo === 'uno');
const fusca = veic.find((v) => v.tipo === 'fusca');
if (!uno) throw new Error('nenhum uno na lista');

const candUno = await candidatos(uno, [-0.3, 1.05, 0]);
console.log(`uno: ${candUno.length} posicoes livres de ${36 * 4 * 3}`);
const candFusca = fusca ? await candidatos(fusca, [0, 0.9, 0]) : [];

const TOMADAS = [
  // perfil e a tomada que prova a silhueta
  { nome: 'uno-perfil', c: melhor(candUno, 90, 1.35), fov: 46 },
  { nome: 'uno-perfil-oposto', c: melhor(candUno, 270, 1.35), fov: 46 },
  { nome: 'uno-traseira-34', c: melhor(candUno, 145, 1.65), fov: 46 },
  { nome: 'uno-frente-34', c: melhor(candUno, 40, 1.65), fov: 46 },
  // visao de jogador: olho a 1.65 m, FOV de jogo
  { nome: 'uno-olho-jogador', c: melhor(candUno.filter((k) => k.dist <= 6.5 && k.alt === 1.65), 55, 1.65), fov: 75 },
  { nome: 'uno-alto-34', c: melhor(candUno, 200, 2.4), fov: 50 },
];
if (fusca) TOMADAS.push({ nome: 'fusca-perfil-comparacao', c: melhor(candFusca, 90, 1.35), fov: 40 });

for (const t of TOMADAS) {
  if (!t.c) { console.log('  !! sem posicao livre para', t.nome); continue; }
  await page.evaluate(([p, a, f]) => window.__pose(p, a, f), [t.c.cam, t.c.alvo, t.fov]);
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(PASTA, `${t.nome}.png`) });
  console.log(`  -> ${t.nome.padEnd(26)} ang=${String(t.c.ang).padStart(3)} dist=${t.c.dist} alt=${t.c.alt}`);
}

// perfil sob luz plana: julga a geometria sem o contraste do entardecer esconder
const perfil = TOMADAS[0].c;
if (perfil) {
  await page.evaluate(() => window.__luzPlana(true));
  await page.evaluate(([p, a, f]) => window.__pose(p, a, f), [perfil.cam, perfil.alvo, 46]);
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(PASTA, 'uno-perfil-luz-plana.png') });
  await page.evaluate(() => window.__luzPlana(false));
}

const stats = await page.evaluate(() => window.__stats());
console.log('STATS mundo:', JSON.stringify(stats.mundo));
console.log('erros de console:', erros.length);
await browser.close();
vite.kill();
