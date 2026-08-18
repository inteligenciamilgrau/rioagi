/** Agachar tem de funcionar com C, e Ctrl nao pode mais agachar. */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const ROOT = process.cwd(), PORT = Number(process.env.PORT ?? 5279);
const vite = spawn(process.execPath, [ROOT+'/node_modules/vite/bin/vite.js','--config','tools/vite.diag.config.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'], {cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{const t=setTimeout(()=>j(new Error('t/o')),60000);vite.stdout.on('data',d=>{if(/ready in|Local:/i.test(String(d))){clearTimeout(t);r();}});});
const b = await chromium.launch({headless:true, executablePath:process.env.PW_CHROME||undefined, args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio']});
const p = await b.newPage({viewport:{width:1280,height:720}});
await p.goto('http://127.0.0.1:'+PORT+'/', {waitUntil:'load', timeout:120000});
await p.waitForFunction(()=>window.__game?.ready, undefined, {timeout:240000});
await p.waitForTimeout(1200);
let falhas=0; const checa=(n,ok,d='')=>{console.log((ok?'  OK  ':' FALHA')+'  '+n+(d?'   '+d:''));if(!ok)falhas++;};
const r = await p.evaluate(() => {
  const ctx = window.__game.ctx, inp = ctx.input;
  const set = (code, on) => inp.keys[on?'add':'delete'](code);
  const lerAgachado = () => inp.isDown('crouch');
  set('KeyC', true);  const comC = lerAgachado();  set('KeyC', false);
  set('ControlLeft', true); const comCtrl = lerAgachado(); set('ControlLeft', false);
  const semNada = lerAgachado();
  // Andar para a frente agachado: C + W juntos, sem Ctrl no meio.
  set('KeyC', true); set('KeyW', true);
  const andandoAgachado = inp.isDown('crouch') && inp.isDown('forward');
  set('KeyC', false); set('KeyW', false);
  return { comC, comCtrl, semNada, andandoAgachado };
});
console.log('');
console.log('=== tecla de agachar ===');
checa('C agacha', r.comC === true);
checa('Ctrl NAO agacha mais', r.comCtrl === false, 'Ctrl+W fecharia a aba');
checa('sem tecla, em pe', r.semNada === false);
checa('C + W: anda agachado para a frente', r.andandoAgachado === true);

// --- combos de Ctrl que atrapalham a partida ---
const ctrl = await p.evaluate(() => {
  const ctx = window.__game.ctx;
  ctx.input.locked = true;              // em partida
  const disp = (code, extra) => {
    const ev = new KeyboardEvent('keydown', Object.assign({
      code, key: code.replace('Key','').toLowerCase(), ctrlKey: true,
      bubbles: true, cancelable: true,
    }, extra || {}));
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  const emPartida = { s: disp('KeyS'), d: disp('KeyD'), p: disp('KeyP'),
                      r: disp('KeyR'), i: disp('KeyI', { shiftKey: true }) };
  ctx.input.locked = false;             // fora de partida
  const foraDePartida = { s: disp('KeyS'), d: disp('KeyD') };
  return { emPartida, foraDePartida };
});
console.log('');
console.log('=== combos de Ctrl EM PARTIDA ===');
checa('Ctrl+S engolido (nao abre salvar)', ctrl.emPartida.s === true);
checa('Ctrl+D engolido (nao abre favorito)', ctrl.emPartida.d === true);
checa('Ctrl+P engolido (nao abre imprimir)', ctrl.emPartida.p === true);
checa('Ctrl+R NAO e sequestrado', ctrl.emPartida.r === false, 'recarregar e do usuario');
checa('Ctrl+Shift+I NAO e sequestrado', ctrl.emPartida.i === false, 'ferramentas sao do usuario');
console.log('');
console.log('=== fora de partida o navegador manda ===');
checa('Ctrl+S livre', ctrl.foraDePartida.s === false);
checa('Ctrl+D livre', ctrl.foraDePartida.d === false);

await b.close(); vite.kill();
console.log('');
console.log(falhas===0 ? '>>> OK' : '>>> '+falhas+' FALHA(S)');
process.exit(falhas===0?0:1);
