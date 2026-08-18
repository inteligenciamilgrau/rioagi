/**
 * Verifica o painel de coordenadas do F3: aparece, some, e os numeros batem
 * com a posicao real do jogador.
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const ROOT = process.cwd(), PORT = Number(process.env.PORT ?? 5271);
const vite = spawn(process.execPath, [ROOT+'/node_modules/vite/bin/vite.js','--config','tools/vite.diag.config.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'], {cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{const t=setTimeout(()=>j(new Error('t/o')),60000);vite.stdout.on('data',d=>{if(/ready in|Local:/i.test(String(d))){clearTimeout(t);r();}});});
const b = await chromium.launch({headless:true, executablePath:process.env.PW_CHROME||undefined, args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio']});
const p = await b.newPage({viewport:{width:1280,height:720}});
p.on('pageerror', e => console.log('PAGEERR:', String(e).split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`, {waitUntil:'load', timeout:120000});
await p.waitForFunction(()=>window.__game?.ready, undefined, {timeout:240000});
await p.waitForTimeout(1500);

let falhas = 0;
const checa = (n, ok, d='') => { console.log(`${ok?'  OK  ':' FALHA'}  ${n}${d?'   '+d:''}`); if(!ok) falhas++; };

const estadoInicial = await p.evaluate(() => {
  const el = document.getElementById('debug-coord');
  return { existe: !!el, visivel: el ? getComputedStyle(el).display !== 'none' : false };
});
checa('o painel existe no DOM', estadoInicial.existe);

// liga o F3 e roda alguns quadros
const dados = await p.evaluate(async () => {
  const ctx = window.__game.ctx;
  ctx.state = 'jogando';
  const et = ctx.etiquetas || ctx.debug || null;
  // liga via tecla, que e o caminho do usuario
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F3', bubbles: true }));
  for (let i = 0; i < 30; i++) { ctx.player.update(1/60); et?.update?.(1/60); }
  const el = document.getElementById('debug-coord');
  const pos = ctx.player.position;
  return {
    visivel: getComputedStyle(el).display !== 'none',
    texto: el.textContent,
    real: { x: +pos.x.toFixed(2), y: +pos.y.toFixed(2), z: +pos.z.toFixed(2) },
    olho: +(ctx.player.eyePosition?.y ?? 0).toFixed(2),
  };
});

console.log('\n=== painel com F3 ligado ===');
console.log(dados.texto.split('\n').map(l => '   | ' + l).join('\n'));
checa('ficou visivel', dados.visivel);
checa('mostra X real', dados.texto.includes(String(dados.real.x)), `esperado ${dados.real.x}`);
checa('mostra Y real (pes)', dados.texto.includes(String(dados.real.y)), `esperado ${dados.real.y}`);
checa('mostra Z real', dados.texto.includes(String(dados.real.z)), `esperado ${dados.real.z}`);
checa('mostra a altura do olho', dados.texto.includes(String(dados.olho)), `esperado ${dados.olho}`);
checa('mostra rumo', /rumo\s+\d{3}°/.test(dados.texto));
checa('mostra o chao', /chão/.test(dados.texto));

const depoisDesligar = await p.evaluate(async () => {
  const ctx = window.__game.ctx;
  const et = ctx.etiquetas || ctx.debug || null;
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F3', bubbles: true }));
  for (let i = 0; i < 10; i++) et?.update?.(1/60);
  return getComputedStyle(document.getElementById('debug-coord')).display !== 'none';
});
checa('F3 de novo esconde', depoisDesligar === false);

await p.screenshot({path: ROOT + '/shots/f3-coordenadas.png'});
await b.close(); vite.kill();
console.log(falhas === 0 ? '\n>>> OK' : `\n>>> ${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);
