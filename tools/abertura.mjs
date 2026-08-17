/**
 * Fotografa a sequência de abertura em cada etapa e em cada resolução.
 *
 *   shots/abertura-precarga-<res>.png   camada estática do index.html
 *   shots/abertura-carga30-<res>.png    carregamento a 30%
 *   shots/abertura-revela-<res>.png     meio da revelação do título
 *   shots/abertura-menu-<res>.png       menu assentado
 *
 * Uso: node tools/abertura.mjs [1280x720,1920x1080]
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
  p.on('console', (m) => { if (/capa|logot/i.test(m.text())) console.log(`  [${res}]`, m.text().slice(0, 80)); });

  const t0 = Date.now();
  await p.goto('http://127.0.0.1:5173/', { waitUntil: 'commit', timeout: 60000 });

  // 1. pré-carga: a arte tem de estar de pé muito antes de o jogo bootar
  await p.waitForSelector('#pre-carga .arte-foto.pronta', { timeout: 30000 });
  console.log(`[${res}] arte da pré-carga visível em ${Date.now() - t0} ms`);
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${ROOT}/shots/abertura-precarga-${res}.png` });

  // 2. espera o boot terminar de verdade
  await p.waitForFunction(() => window.__game?.ready, null, { timeout: 300000 });
  await p.waitForFunction(() => document.querySelector('#tela-menu.ativa'), null, { timeout: 300000 });
  const tMenu = Date.now() - t0;
  await p.waitForTimeout(2400);

  // 3. carregamento a 30% (reencenado: no fluxo real ele dura ~0,4 s)
  await p.evaluate(() => {
    const ctx = window.__game.ctx;
    ctx.hud?.setVisible?.(false);
    ctx.menu.mostrar('carga');
    ctx.bus.emit('boot:progress', { label: 'Erguendo a favela', pct: 0.3 });
  });
  await p.waitForTimeout(700);
  await p.screenshot({ path: `${ROOT}/shots/abertura-carga30-${res}.png` });

  // 4. revelação do título. O screenshot em software rendering demora ~1 s, o
  //    que borraria o instante; então congelamos o relógio das animações num
  //    ponto exato da coreografia (Web Animations API) antes de fotografar.
  for (const t of [560, 1120]) {
    await p.evaluate((ms) => {
      const m = window.__game.ctx.menu;
      m._encerrarRevelacao();
      m._jaRevelou = false;
      m._revelar();
      for (const a of document.getAnimations()) { a.pause(); a.currentTime = ms; }
    }, t);
    await p.waitForTimeout(250);
    await p.screenshot({ path: `${ROOT}/shots/abertura-revela${t}-${res}.png` });
  }

  // 5. menu assentado
  await p.evaluate(() => {
    const m = window.__game.ctx.menu;
    for (const a of document.getAnimations()) a.play();
    m._encerrarRevelacao();
  });
  await p.waitForTimeout(700);
  const estado = await p.evaluate(() => {
    const r = document.getElementById('menu-root');
    const logo = document.querySelector('#tela-menu .marca-logo');
    const bt = document.querySelector('#tela-menu .bt.primario');
    return {
      revelando: r.classList.contains('revelando'),
      temLogo: !!logo,
      caixaLogo: logo ? logo.getBoundingClientRect().toJSON() : null,
      caixaBt: bt ? bt.getBoundingClientRect().toJSON() : null,
      preCarga: !!document.getElementById('pre-carga'),
      arteMenu: !!document.querySelector('#tela-menu .arte-foto.pronta'),
      arteCarga: !!document.querySelector('#tela-carga .arte-foto.pronta'),
    };
  });
  await p.screenshot({ path: `${ROOT}/shots/abertura-menu-${res}.png` });
  console.log(`[${res}] menu em ${tMenu} ms · ${JSON.stringify(estado)}`);

  // 6. teste do pulo: tecla no meio da revelação corta tudo
  const pulo = await p.evaluate(async () => {
    const m = window.__game.ctx.menu;
    m._jaRevelou = false;
    m._revelar();
    const antes = document.getElementById('menu-root').classList.contains('revelando');
    await new Promise((r) => setTimeout(r, 250));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    return { antes, depois: document.getElementById('menu-root').classList.contains('revelando') };
  });
  await p.waitForTimeout(450);
  await p.screenshot({ path: `${ROOT}/shots/abertura-pulo-${res}.png` });
  console.log(`[${res}] pulo: revelando antes=${pulo.antes} depois=${pulo.depois}`);

  // 7. prefers-reduced-motion: sem coreografia, só o estado final
  await p.emulateMedia({ reducedMotion: 'reduce' });
  await p.waitForFunction(() => window.__game?.ready, null, { timeout: 300000 });
  const semMov = await p.evaluate(() => {
    const m = window.__game.ctx.menu;
    m._encerrarRevelacao();
    m._jaRevelou = false;
    m.mostrar('carga');
    m._revelar();
    return {
      revelando: document.getElementById('menu-root').classList.contains('revelando'),
      menuAtivo: !!document.querySelector('#tela-menu.ativa'),
      animacoes: document.getAnimations().filter((a) => a.playState === 'running').length,
    };
  });
  await p.waitForTimeout(500);
  await p.screenshot({ path: `${ROOT}/shots/abertura-semmov-${res}.png` });
  console.log(`[${res}] reduced-motion: ${JSON.stringify(semMov)}`);
  await p.emulateMedia({ reducedMotion: null });

  await p.close();
}
await b.close();
