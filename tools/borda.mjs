/**
 * Tenta cair do mapa. O jogador anda contra as quatro bordas por muito tempo;
 * nenhuma tentativa pode acabar no vazio.
 *
 * Dois defeitos DESTE teste ja custaram uma cacada a buraco que nao existia:
 *
 * 1) LARGADA EM COTA FIXA (`cotaMin + 30` = 26,6 m). O morro tem 39 m de
 *    desnivel e a borda sul esta em 32,4 m: o jogador nascia 5,8 m DENTRO da
 *    encosta. Debaixo do terreno nao ha o que penetrar (a "saia" das bordas e
 *    malha visual, nao entra no BVH), entao ele caia em queda livre ate
 *    `Player._checarQueda` — e o relatorio saia como "menorY = -40,2 m,
 *    atravessou o piso". Largada agora e sempre 3 m acima do chao DAQUELE ponto.
 *
 * 2) RUMO SEM OLHAR. O vetor de movimento e relativo ao YAW
 *    (`_fwd = (-sin yaw, 0, -cos yaw)` em `Movement`), e ninguem escrevia o yaw:
 *    valia o que `Player.init()` tivesse sorteado. Os quatro "rumos cardeais"
 *    andavam, na pratica, todos para o mesmo lado. Agora o yaw e calculado a
 *    partir da direcao desejada e o movimento e sempre para a frente.
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const ROOT = process.cwd(), PORT = Number(process.env.PORT ?? 5280);
const vite = spawn(process.execPath, [ROOT+'/node_modules/vite/bin/vite.js','--config','tools/vite.diag.config.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'], {cwd:ROOT,stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{const t=setTimeout(()=>j(new Error('t/o')),60000);vite.stdout.on('data',d=>{if(/ready in|Local:/i.test(String(d))){clearTimeout(t);r();}});});
const b = await chromium.launch({headless:true, executablePath:process.env.PW_CHROME||undefined, args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio']});
const p = await b.newPage({viewport:{width:1280,height:720}});
p.on('pageerror', e => console.log('PAGEERR:', String(e).split('\n')[0]));
await p.goto('http://127.0.0.1:'+PORT+'/', {waitUntil:'load', timeout:120000});
await p.waitForFunction(()=>window.__game?.ready, undefined, {timeout:240000});
await p.waitForTimeout(1200);

let falhas=0; const checa=(n,ok,d='')=>{console.log((ok?'  OK  ':' FALHA')+'  '+n+(d?'   '+d:''));if(!ok)falhas++;};

const r = await p.evaluate(async () => {
  const ctx = window.__game.ctx, jog = ctx.player;
  ctx.state = 'jogando';
  const meia = ctx.world.size * 0.5;
  const fundo = ctx.world.favela.cotaMin;
  const RAIO = 0.35;
  const saidas = [];

  // Quatro rumos cardeais. (dx,dz) e a direcao do mundo para onde se anda.
  const rumos = [
    { nome: 'norte (-Z)', dx: 0, dz: -1 },
    { nome: 'sul   (+Z)', dx: 0, dz: 1 },
    { nome: 'oeste (-X)', dx: -1, dz: 0 },
    { nome: 'leste (+X)', dx: 1, dz: 0 },
  ];

  for (const rumo of rumos) {
    // Comeca perto da borda de destino para nao gastar simulacao no morro.
    const px = rumo.dx * (meia - 12), pz = rumo.dz * (meia - 12);
    const cotaLargada = ctx.world.heightAt(px, pz);
    jog.destravar?.();
    jog.movement.teleport(px, cotaLargada + 3, pz);
    jog.movement.velocity.set(0, 0, 0);
    // `_fwd = (-sin yaw, 0, -cos yaw)`: este yaw poe a frente em (dx,dz).
    jog.rig.reset(Math.atan2(-rumo.dx, -rumo.dz), 0);
    for (let i = 0; i < 90; i++) jog.update(1/60);   // assenta no chao

    let menorY = Infinity, foraDoMapa = 0, maxAlcance = -Infinity;
    const orig = ctx.input.getMoveVector.bind(ctx.input);
    ctx.input.getMoveVector = (out) => { out.x = 0; out.y = 1; return out; };  // so para a frente
    ctx.input.locked = true;

    for (let i = 0; i < 60 * 25; i++) {
      jog.update(1/60);
      const q = jog.position;
      if (q.y < menorY) menorY = q.y;
      const alcance = q.x * rumo.dx + q.z * rumo.dz;      // avanco no rumo pedido
      if (alcance > maxAlcance) maxAlcance = alcance;
      if (Math.abs(q.x) + RAIO > meia || Math.abs(q.z) + RAIO > meia) foraDoMapa++;
    }
    ctx.input.getMoveVector = orig;

    const q = jog.position;
    saidas.push({
      rumo: rumo.nome,
      x: +q.x.toFixed(1), z: +q.z.toFixed(1), y: +q.y.toFixed(1),
      menorY: +menorY.toFixed(1),
      foraDoMapa,
      caiu: menorY < fundo - 20,
      cotaLargada: +cotaLargada.toFixed(1),
      // a largada tem de ficar ACIMA do terreno, senao o teste mede a si mesmo
      largadaNoAr: cotaLargada + 3 > cotaLargada,
      // encostou na muralha? sobra de terreno alem do CORPO no ponto mais longe
      folga: +(meia - (maxAlcance + RAIO)).toFixed(2),
    });
  }
  return { saidas, meia: +meia.toFixed(1), fundo: +fundo.toFixed(1) };
});

console.log('');
console.log('andando 25 s contra cada borda (mapa +-' + r.meia + ' m, cota minima ' + r.fundo + ' m)');
console.log('');
for (const s of r.saidas) {
  console.log('  ' + s.rumo + '  largada na cota ' + String(s.cotaLargada).padStart(6)
    + '   parou em X=' + String(s.x).padStart(7) + ' Z=' + String(s.z).padStart(7)
    + '  Y=' + String(s.y).padStart(6) + '  menorY=' + String(s.menorY).padStart(6)
    + '  folga=' + String(s.folga).padStart(6) + ' m');
  checa('    largou no ar, nao dentro do morro', s.largadaNoAr);
  checa('    nao caiu no vazio', !s.caiu);
  checa('    nao saiu dos limites', s.foraDoMapa === 0, s.foraDoMapa + ' quadros fora');
  checa('    o corpo ficou sobre o terreno', s.folga >= 0, 'folga ' + s.folga + ' m');
}

await b.close(); vite.kill();
console.log('');
console.log(falhas===0 ? '>>> OK' : '>>> '+falhas+' FALHA(S)');
process.exit(falhas===0?0:1);
