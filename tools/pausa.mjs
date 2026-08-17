/**
 * Confere a marca na tela de pausa: aparece, não empurra os botões para fora da
 * janela, continua clicável, e não reanima da segunda vez em diante.
 *
 * Uso: node tools/pausa.mjs [1280x720,1920x1080]
 * Precisa do vite de pé em 127.0.0.1:5173.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const ROOT = process.cwd();
const RES = (process.argv[2] || '1280x720,1600x900,1920x1080').split(',');
mkdirSync(ROOT + '/shots', { recursive: true });

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});

for (const res of RES) {
  const [W, H] = res.split('x').map(Number);
  const p = await b.newPage({ viewport: { width: W, height: H } });
  p.setDefaultTimeout(300000);
  p.on('pageerror', (e) => console.log(`  PAGEERR ${res}:`, e.message.split('\n')[0]));

  await p.goto('http://127.0.0.1:5173/', { waitUntil: 'commit', timeout: 60000 });
  await p.waitForFunction(() => window.__game?.ready, null, { timeout: 300000 });
  await p.waitForFunction(() => document.querySelector('#tela-menu.ativa'), null, { timeout: 300000 });
  await p.waitForTimeout(2200);

  // Primeira pausa da sessão: a marca entra junto com o painel.
  const um = await p.evaluate(() => {
    const ctx = window.__game.ctx;
    ctx.state = 'pausado';
    ctx.hud?.setVisible?.(false);
    ctx.menu.mostrar('pausa');
    return document.getElementById('tela-pausa').classList.contains('ja-vista');
  });
  await p.waitForTimeout(900);
  await p.screenshot({ path: `${ROOT}/shots/abertura-pausa-${res}.png` });

  const medida = await p.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const r = (s) => { const e = q(s); return e ? e.getBoundingClientRect().toJSON() : null; };
    const marca = q('#tela-pausa .marca-pausa');
    const img = q('#tela-pausa .marca-pausa img');
    const painel = q('#tela-pausa .painel');
    const bts = [...document.querySelectorAll('#tela-pausa .bt')].map((b) => b.getBoundingClientRect().toJSON());
    const pb = painel.getBoundingClientRect();
    // o botão de baixo ainda está dentro da janela?
    const ultimo = bts[bts.length - 1];
    // quem recebe o clique no centro do botão primário?
    const b0 = bts[0];
    const alvo = document.elementFromPoint(b0.x + b0.width / 2, b0.y + b0.height / 2);
    return {
      temMarca: !!marca,
      imgCarregada: img ? img.complete && img.naturalWidth > 0 : null,
      marca: r('#tela-pausa .marca-pausa'),
      opacidade: marca ? getComputedStyle(marca).opacity : null,
      animacao: marca ? getComputedStyle(marca).animationName : null,
      painelTopo: +pb.top.toFixed(1),
      painelBase: +pb.bottom.toFixed(1),
      cabeNaJanela: pb.top >= 0 && ultimo.bottom <= innerHeight,
      folgaTopo: +pb.top.toFixed(1),
      folgaBase: +(innerHeight - ultimo.bottom).toFixed(1),
      cliqueChegaNoBotao: alvo ? alvo.closest('.bt')?.dataset.acao ?? alvo.tagName : null,
    };
  });
  console.log(`[${res}] 1a pausa (ja-vista=${um}) ${JSON.stringify(medida)}`);

  // Segunda pausa: a marca não pode reanimar.
  const dois = await p.evaluate(() => {
    const ctx = window.__game.ctx;
    ctx.menu.mostrar(null);
    ctx.menu.mostrar('pausa');
    const m = document.querySelector('#tela-pausa .marca-pausa');
    return {
      jaVista: document.getElementById('tela-pausa').classList.contains('ja-vista'),
      animacao: getComputedStyle(m).animationName,
      animacoesAtivas: m.getAnimations().length,
    };
  });
  console.log(`[${res}] 2a pausa ${JSON.stringify(dois)}`);
  await p.close();
}
await b.close();
