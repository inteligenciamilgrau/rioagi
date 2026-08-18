import { chromium } from 'playwright';

const PAGES = [
  ['/', 'jogo completo'],
  ['/world.html', 'favela'],
  ['/test/materials.html', 'materiais'],
  ['/test/player.html', 'armas'],
  ['/test/core.html', 'ceu/luz'],
];

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});

for (const [path, nome] of PAGES) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const erros = [];
  page.on('pageerror', (e) => erros.push(e.message.split('\n')[0]));
  page.on('console', (m) => { if (m.type() === 'error') erros.push(m.text().split('\n')[0]); });

  try {
    await page.goto('http://127.0.0.1:5173' + path, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(12000);
    // A pagina desenhou alguma coisa no canvas?
    const info = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      if (!c) return { canvas: false };
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      return { canvas: true, w: c.width, h: c.height, gl: !!gl };
    });
    const status = erros.length === 0 ? 'OK' : `${erros.length} erro(s)`;
    console.log(`${status.padEnd(12)} ${path}  (${nome})  canvas=${info.canvas} ${info.w||0}x${info.h||0}`);
    for (const e of [...new Set(erros)].slice(0, 3)) console.log(`      ↳ ${e.slice(0, 160)}`);
  } catch (err) {
    console.log(`FALHOU       ${path}  (${nome})  ${err.message.split('\n')[0].slice(0, 120)}`);
  }
  await page.close();
}
await browser.close();
