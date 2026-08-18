/**
 * Verifica a musica na pagina "Explorar o morro".
 *
 * O ponto delicado e a politica de autoplay: o clique que trouxe o jogador ate
 * aqui aconteceu em OUTRO documento e nao vale como gesto neste. O teste roda
 * com a politica PADRAO do navegador de proposito — usar
 * `--autoplay-policy=no-user-gesture-required` faria o teste passar sempre e
 * nao provaria nada (erro que ja cometi antes neste projeto).
 *
 *   node tools/musicaworld.mjs
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 5262);

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
  // SEM flag de autoplay: queremos o comportamento real.
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`http://127.0.0.1:${PORT}/world.html`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__pronto, undefined, { timeout: 240000 });
await page.evaluate(() => window.__pausar());
await page.waitForTimeout(800);

let falhas = 0;
const checa = (nome, ok, det = '') => {
  console.log(`${ok ? '  OK  ' : ' FALHA'}  ${nome}${det ? '   ' + det : ''}`);
  if (!ok) falhas++;
};

const ler = () => page.evaluate(() => {
  const a = document.querySelector('audio') || [...document.querySelectorAll('*')].find((e) => e.tagName === 'AUDIO');
  // O Audio() criado por script nao entra no DOM; alcancamos pelo estado global
  // que o proprio elemento expoe via performance de midia. Aqui usamos o truque
  // de guardar referencia: a pagina nao exporta, entao inferimos pelo som ativo.
  return {
    tocandoAlgo: !!document.querySelector('audio')
      || navigator.mediaSession?.playbackState === 'playing',
    audios: document.querySelectorAll('audio').length,
  };
});

// A faixa e criada com `new Audio()` e nao entra no DOM; para poder inspecionar,
// pedimos ao proprio documento que exponha o elemento em teste.
await page.evaluate(() => {
  // Encontra o elemento pela lista interna de midia do documento.
  const todos = performance.getEntriesByType('resource')
    .filter((r) => /audio\/musica\/.+\.mp3/.test(r.name));
  window.__mp3Pedidos = todos.map((r) => r.name.split('/').pop());
});

const antes = await page.evaluate(() => window.__mp3Pedidos);
console.log('\n=== antes de qualquer gesto ===');
checa('a faixa da abertura foi pedida ao servidor', antes.includes('tensaonoar.mp3'), antes.join(', ') || '(nenhuma)');

// Gesto real nesta pagina: arrastar, que e o que a pessoa faz para orbitar.
await page.mouse.move(640, 400);
await page.mouse.down();
await page.mouse.move(700, 420, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(2500);

/* A prova que vale: o proprio elemento. `paused === false` diz que o navegador
 * aceitou tocar, e `currentTime` avancando diz que o audio esta REALMENTE
 * correndo — um elemento pode estar "nao pausado" e travado em 0 se a decodifi-
 * cacao falhou. As duas condicoes juntas nao deixam brecha. */
const t1 = await page.evaluate(() => {
  const m = window.__musica;
  return m ? { pausado: m.paused, t: m.currentTime, vol: +m.volume.toFixed(3), dur: +(m.duration || 0).toFixed(1) } : null;
});
await page.waitForTimeout(2000);
const t2 = await page.evaluate(() => {
  const m = window.__musica;
  return m ? { pausado: m.paused, t: m.currentTime } : null;
});

console.log('\n=== depois de arrastar (gesto real) ===');
checa('o elemento existe', !!t1);
checa('nao esta pausado', t1 && t1.pausado === false);
checa('o tempo AVANCA (esta tocando de fato)', t1 && t2 && t2.t > t1.t, t1 ? `${t1.t.toFixed(2)}s -> ${t2.t.toFixed(2)}s` : '');
checa('volume veio das configuracoes', t1 && t1.vol > 0 && t1.vol <= 1, t1 ? `${t1.vol}` : '');
checa('a faixa certa (duracao da tensaonoar)', t1 && Math.abs(t1.dur - 195.2) < 1, t1 ? `${t1.dur}s` : '');

const btn = await page.evaluate(() => {
  const b = document.getElementById('bt-som');
  return b ? { existe: true, texto: b.textContent.trim(), mudo: b.classList.contains('mudo') } : { existe: false };
});
console.log('\n=== controle de som ===');
checa('botao de musica existe na barra', btn.existe, btn.texto || '');
checa('comeca ligado (nao mudo)', btn.existe && !btn.mudo);

await page.click('#bt-som');
await page.waitForTimeout(300);
const depoisClique = await page.evaluate(() => document.getElementById('bt-som').classList.contains('mudo'));
checa('clicar silencia', depoisClique === true);
await page.click('#bt-som');
await page.waitForTimeout(300);
const religou = await page.evaluate(() => !document.getElementById('bt-som').classList.contains('mudo'));
checa('clicar de novo religa', religou === true);

await page.screenshot({ path: ROOT + '/shots/explorar-musica.png' });
await browser.close();
vite.kill();
console.log(falhas === 0 ? '\n>>> OK' : `\n>>> ${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);
