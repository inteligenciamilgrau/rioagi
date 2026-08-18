/**
 * Prova o conserto da coleta e a mochila.
 *
 * O bug relatado: entrar numa sala com itens, passar por cima e nada acontecer.
 * A causa era a regra "se nao serve AGORA, ignora e deixa no chao" — com vida
 * e municao cheias, kit e munição eram simplesmente pulados.
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const ROOT = process.cwd(), PORT = Number(process.env.PORT ?? 5272);
const vite = spawn(process.execPath, [ROOT+'/node_modules/vite/bin/vite.js','--config','tools/vite.diag.config.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'], {cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{const t=setTimeout(()=>j(new Error('t/o')),60000);vite.stdout.on('data',d=>{if(/ready in|Local:/i.test(String(d))){clearTimeout(t);r();}});});
const b = await chromium.launch({headless:true, executablePath:process.env.PW_CHROME||undefined, args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio']});
const p = await b.newPage({viewport:{width:1280,height:720}});
p.on('pageerror', e => console.log('PAGEERR:', String(e).split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`, {waitUntil:'load', timeout:120000});
await p.waitForFunction(()=>window.__game?.ready, undefined, {timeout:240000});
await p.waitForTimeout(1200);

let falhas = 0;
const checa = (n, ok, d='') => { console.log(`${ok?'  OK  ':' FALHA'}  ${n}${d?'   '+d:''}`); if(!ok) falhas++; };

const r = await p.evaluate(async () => {
  const ctx = window.__game.ctx;
  const jog = ctx.player, pk = ctx.pickups, mo = ctx.mochila;
  ctx.state = 'jogando';
  mo.reset();

  // Cenario do bug: TUDO cheio. Antes, pisar num kit nao fazia nada.
  jog.health = jog.maxHealth;
  for (const s of jog.weapons.slots) s.reserve = s.def?.reserveAmmo ?? s.reserve;

  const largar = (tipo) => {
    const pos = jog.position.clone();
    pk.soltar ? pk.soltar(tipo, pos) : pk.dropar?.(tipo, pos);
    return pos;
  };

  // Cria itens exatamente sob os pes usando a API interna disponivel.
  const criar = (tipo) => {
    const pos = jog.position.clone();
    // procura o metodo de criacao publicado pelo modulo
    const fn = pk.soltar || pk.dropar || pk.criar || pk._criar || pk.adicionar;
    if (typeof fn === 'function') { fn.call(pk, tipo, pos); return true; }
    return false;
  };

  /* O mapa ja nasce com itens fixos dentro das casas, entao contar o total no
   * chao nao diz nada. O que importa e o DELTA: criei um, ele saiu? */
  const antesChao = pk.itens.filter(i => i.ativo).length;
  const apiOk = criar('kit');
  for (let i = 0; i < 20; i++) pk.update(1/60);
  const depoisKitCheio = { ...mo.itens, delta: pk.itens.filter(i => i.ativo).length - antesChao };

  // Agora machucado: usar da mochila tem de curar
  jog.health = 40;
  const usou = mo.usar();
  const depoisUsar = { ...mo.itens, vida: jog.health };

  // Encher a mochila de kit e ver se o excedente FICA no chao
  mo.reset(); jog.health = jog.maxHealth;
  const antes2 = pk.itens.filter(i => i.ativo).length;
  for (let k = 0; k < 5; k++) { criar('kit'); for (let i = 0; i < 12; i++) pk.update(1/60); }
  const cheia = { ...mo.itens, delta: pk.itens.filter(i => i.ativo).length - antes2 };

  return { apiOk, depoisKitCheio, usou, depoisUsar, cheia, cap: 3 };
});

console.log('\n=== pisar num kit com a vida CHEIA (o bug relatado) ===');
checa('a API de criar item foi encontrada', r.apiOk);
checa('o kit foi GUARDADO na mochila', r.depoisKitCheio.kit === 1, JSON.stringify(r.depoisKitCheio));
checa('e saiu do chao (delta zero)', r.depoisKitCheio.delta === 0, `delta ${r.depoisKitCheio.delta}`);

console.log('\n=== usar da mochila quando precisa ===');
checa('usar gastou um kit', r.usou === true);
checa('curou de verdade', r.depoisUsar.vida > 40, `vida ${r.depoisUsar.vida}`);
checa('a mochila esvaziou o slot', r.depoisUsar.kit === 0, JSON.stringify(r.depoisUsar));

console.log('\n=== teto por tipo ===');
checa(`guarda no maximo ${r.cap} kits`, r.cheia.kit === r.cap, `kit=${r.cheia.kit}`);
checa('o excedente FICA no chao', r.cheia.delta === 2, `delta ${r.cheia.delta} (5 criados - 3 guardados)`);

await b.close(); vite.kill();
console.log(falhas === 0 ? '\n>>> OK' : `\n>>> ${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);
