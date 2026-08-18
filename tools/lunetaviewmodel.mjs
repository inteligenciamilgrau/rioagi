/**
 * Prova o que ocupa o campo da luneta: cenario real, sniper em ADS, dois
 * quadros identicos — um com o viewmodel visivel e outro sem.
 *
 * Se a mancha escura sumir quando o viewmodel some, o culpado e a arma; se
 * ficar, e terreno e a luneta esta correta.
 *
 * Mede tambem a fracao ESCURA dentro do circulo da luneta nos dois casos, para
 * o veredito nao depender de eu olhar e achar.
 *
 *   node tools/lunetaviewmodel.mjs
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 5251);

const vite = spawn(process.execPath, [
  ROOT + '/node_modules/vite/bin/vite.js',
  '--config', 'tools/vite.diag.config.js',
  '--host', '127.0.0.1', '--port', String(PORT), '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r, j) => {
  const t = setTimeout(() => j(new Error('timeout vite')), 60000);
  vite.stdout.on('data', (d) => { if (/ready in|Local:/i.test(String(d))) { clearTimeout(t); r(); } });
});

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PW_CHROME || undefined,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERR:', String(e).split('\n')[0]));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__game?.ready, { timeout: 240000 });
await page.waitForTimeout(1200);

/* NAO clicar em "Jogar": isso inicia uma partida de verdade, e os ~150 frames
 * simulados de `preparar()` correm com hostis ativos — o jogador morre e a
 * captura sai na tela de morte. O caminho de menu abaixo deixa o mundo montado
 * sem partida em curso, que e o que este teste quer. */

// Pose fixa: de um spawn, olhando no horizonte. Mesma pose nos dois quadros.
async function preparar(comViewModel) {
  await page.evaluate(async (mostra) => {
    const ctx = window.__game.ctx;
    /* `hideAll()` sozinho NAO tira o menu nem liga o HUD — armadilha ja
     * documentada por quem mexeu na luneta antes. A sequencia que funciona e
     * `mostrar(null)` + `hud.setVisible(true)`. Sem isso a captura sai do menu
     * principal e o teste inteiro mede a coisa errada. */
    ctx.menu?.mostrar?.(null);
    ctx.menu?.hideAll?.();
    ctx.hud?.setVisible?.(true);
    ctx.state = 'jogando';
    ctx.player.weapons.switchTo(1);            // sniper
    for (let i = 0; i < 60; i++) ctx.player.update(1 / 60);
    window.__game.poseAt(0, 0, -2, { simulate: true });
    ctx.player.forceADS?.(true);
    for (let i = 0; i < 90; i++) ctx.player.update(1 / 60);
    ctx.player.viewModel?.setVisible?.(mostra);
    ctx.hud.update(1 / 60);
    window.__game.settle?.(14);
  }, comViewModel);

  /* Esperar o menu SAIR de verdade. Chamar `mostrar(null)` nao e suficiente: o
   * menu principal sobe ~420 ms depois de `__game.ready`, entao a primeira
   * captura sai com o menu por cima da luneta se a gente so dormir um pouco.
   * Aqui a condicao e observavel: nenhuma `.tela` com display diferente de
   * none. */
  await page.waitForFunction(() => {
    const telas = [...document.querySelectorAll('#menu-root .tela')];
    return telas.every((t) => getComputedStyle(t).display === 'none');
  }, undefined, { timeout: 30000 }).catch(() => console.log('AVISO: menu nao saiu'));
  await page.waitForTimeout(500);
}

/* NAO tente medir lendo o canvas do jogo com drawImage/getImageData: o contexto
 * WebGL nao preserva o buffer, a leitura volta preta e o teste "mede" 100% de
 * escuro nos dois casos — falso negativo perfeito, que foi o que aconteceu na
 * primeira versao deste arquivo. A prova aqui e a captura do Playwright, que
 * compoe canvas + HUD corretamente. */

/* Descarte: a PRIMEIRA chamada sempre sai com o menu por cima (ele se redesenha
 * logo depois do boot). Da segunda em diante o estado gruda. Medido: rodando
 * sem este aquecimento, a captura 1 saia do menu e a 2 saia certa. */
await preparar(true);

await preparar(true);
await page.screenshot({ path: ROOT + '/shots/luneta-com-arma.png' });

await preparar(false);
await page.screenshot({ path: ROOT + '/shots/luneta-sem-arma.png' });

console.log('\ncapturas geradas:');
console.log('  shots/luneta-com-arma.png   (viewmodel visivel)');
console.log('  shots/luneta-sem-arma.png   (viewmodel oculto)');
console.log('Compare as duas: o que sumir da abertura era a arma.');

await browser.close();
vite.kill();
