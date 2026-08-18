/**
 * muralha.mjs — quanto do mapa a barreira invisivel esta roubando, e o que se
 * ve de la.
 *
 * A quina do mapa vale alguma coisa: e onde alguem corre para escapar. Uma
 * margem generosa demais apaga essa faixa sem que ninguem perceba, porque a
 * parede e invisivel — o jogador so sente que "nao da para ir ate o fim".
 *
 * Mede tres coisas:
 *
 * 1) GEOMETRIA — onde a face interna da muralha esta, quanto de terreno sobra
 *    alem do CORPO do jogador (capsula de raio 0,35 m) e quanto de area jogavel
 *    isso devolve em todo o perimetro.
 *
 * 2) ENCOSTAR — o jogador vai contra as quatro bordas ANDANDO, AGACHADO e
 *    DESLIZANDO. Deslizar contra a borda e justamente o que alguem faz fugindo,
 *    e a capsula agachada tem outra forma: 1,05 m de altura contra 1,80 m.
 *    Nenhum dos tres pode sair dos limites nem cair.
 *
 * 3) O QUE SE VE — encostado na parede, olhando para fora: a que angulo abaixo
 *    do horizonte o chao termina. Angulo pequeno = da para ver a aresta do mapa
 *    sem baixar a cabeca; angulo grande = o fim do mundo so aparece para quem
 *    olhar para os proprios pes. A "saia" do terreno e tratada a parte porque
 *    ela e malha VISUAL e nao esta no BVH de colisao.
 *
 * Uso:  node tools/muralha.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const ROOT = process.cwd(), PORT = Number(process.env.PORT ?? 5282);
const vite = spawn(process.execPath, [ROOT + '/node_modules/vite/bin/vite.js', '--config', 'tools/vite.diag.config.js', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r, j) => { const t = setTimeout(() => j(new Error('t/o')), 60000); vite.stdout.on('data', d => { if (/ready in|Local:/i.test(String(d))) { clearTimeout(t); r(); } }); });
const b = await chromium.launch({ headless: true, executablePath: process.env.PW_CHROME || undefined, args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', e => console.log('PAGEERR:', String(e).split('\n')[0]));
await p.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load', timeout: 120000 });
await p.waitForFunction(() => window.__game?.ready, undefined, { timeout: 240000 });
await p.waitForTimeout(800);

/* SO_FOTO=1 refaz apenas as capturas (a secao 2 leva 12 tentativas de 16 s). */
const SO_FOTO = !!process.env.SO_FOTO;

let falhas = 0;
const checa = (n, ok, d = '') => { console.log((ok ? '  OK  ' : ' FALHA') + '  ' + n + (d ? '   ' + d : '')); if (!ok) falhas++; };

/* ------------------------------------------------------------- 1) geometria */

const geo = await p.evaluate(() => {
  const m = window.__game.ctx.world.muralha, size = window.__game.ctx.world.size;
  const RAIO = 0.35;
  return {
    size, aresta: size * 0.5,
    eixoCaixa: m.meia, faceInterna: m.faceInterna,
    espessura: m.espessura, margem: m.margem, base: m.base, topo: m.topo,
    limiteCorpo: m.faceInterna - RAIO,            // ate onde vai o EIXO da capsula
    folga: size * 0.5 - m.faceInterna,            // terreno alem do CORPO
  };
});
const ladoJogavel = (geo.faceInterna * 2);
console.log('');
console.log('=== 1) GEOMETRIA DA MURALHA ===========================================');
console.log(`  aresta do terreno   +-${geo.aresta.toFixed(2)} m`);
console.log(`  face interna        +-${geo.faceInterna.toFixed(2)} m   <- onde o CORPO para`);
console.log(`  eixo da caixa       +-${geo.eixoCaixa.toFixed(2)} m   (espessura ${geo.espessura} m)`);
console.log(`  eixo da capsula ate +-${geo.limiteCorpo.toFixed(2)} m   (raio 0,35 m)`);
console.log(`  altura              ${geo.base.toFixed(1)} .. ${geo.topo.toFixed(1)} m`);
console.log('');
console.log(`  MARGEM_BORDA = ${geo.margem} m  ->  sobra ${geo.folga.toFixed(2)} m de terreno alem do corpo`);
console.log(`  area jogavel: ${ladoJogavel.toFixed(1)} x ${ladoJogavel.toFixed(1)} m = ${(ladoJogavel ** 2 / 1e4).toFixed(3)} ha`
  + `  (${(100 * (ladoJogavel ** 2) / (geo.size ** 2)).toFixed(1)}% do terreno)`);

/* ------------------------------------------------------------- 2) encostar */

const encostar = await p.evaluate(async (MODOS) => {
  const ctx = window.__game.ctx, jog = ctx.player, mundo = ctx.world, ng = mundo.navGrid;
  ctx.state = 'jogando';
  const meia = mundo.size * 0.5;
  const RAIO = 0.35;
  const limite = mundo.muralha.faceInterna - RAIO;      // ate onde o eixo chega
  const CORRIDA = 13;                                   // m de aproximacao

  const rumos = [
    { nome: 'norte (-Z)', dx: 0, dz: -1 },
    { nome: 'sul   (+Z)', dx: 0, dz: 1 },
    { nome: 'oeste (-X)', dx: -1, dz: 0 },
    { nome: 'leste (+X)', dx: 1, dz: 0 },
  ];

  /* Faixa de aproximacao LIVRE.
   *
   * A primeira versao largava sempre no meio de cada borda e tres dos quatro
   * rumos empacavam numa casa a 15 m da parede: o teste dizia "ninguem saiu do
   * mapa" sem que ninguem tivesse chegado na parede. Agora a faixa e escolhida
   * na malha — 15 m andaveis em linha reta ate a barreira — e o relatorio diz
   * quem encostou de fato. */
  const cel = { x: 0, z: 0 };
  const andavel = (x, z) => {
    ng.worldToCell({ x, y: 0, z }, cel);
    return ng.isWalkable(cel.x, cel.z);
  };
  const escolherFaixa = (r) => {
    const tx = -r.dz, tz = r.dx;                        // tangente da borda
    /* Varre a partir do MEIO da borda para os lados. Varrendo de uma ponta a
     * outra, a primeira faixa limpa cai sempre na quina, que e o pedaco mais
     * acidentado do mapa — o teste largava o jogador entalado e media 0 m/s. */
    const cands = [0];
    for (let d = 2; d <= 74; d += 2) { cands.push(d, -d); }
    let melhor = null, melhorLivres = -1;
    for (const lat of cands) {
      let livres = 0;
      for (let d = CORRIDA; d >= 1; d--) {
        const x = r.dx * (limite - d) + tx * lat, z = r.dz * (limite - d) + tz * lat;
        if (andavel(x, z)) livres++;
      }
      if (livres > melhorLivres) { melhorLivres = livres; melhor = lat; }
      if (livres === CORRIDA) break;                    // faixa limpa, serve
    }
    return { lat: melhor, livres: melhorLivres };
  };

  const saidas = [];
  const origGMV = ctx.input.getMoveVector.bind(ctx.input);
  const origDown = ctx.input.isDown.bind(ctx.input);
  const origPress = ctx.input.wasPressed.bind(ctx.input);

  for (const rumo of rumos) {
    const faixa = escolherFaixa(rumo);
    const tx = -rumo.dz, tz = rumo.dx;
    for (const modo of MODOS) {
      const px = rumo.dx * (limite - CORRIDA) + tx * faixa.lat;
      const pz = rumo.dz * (limite - CORRIDA) + tz * faixa.lat;
      jog.destravar?.();
      jog.movement.teleport(px, mundo.heightAt(px, pz) + 2, pz);
      jog.movement.velocity.set(0, 0, 0);
      // `_fwd = (-sin yaw, 0, -cos yaw)`: sem escrever o yaw, "para a frente"
      // e o lado que o Player.init() sorteou, e o rumo do teste e ficcao.
      jog.rig.reset(Math.atan2(-rumo.dx, -rumo.dz), 0);
      for (let i = 0; i < 90; i++) jog.update(1 / 60);

      let agachar = modo === 'agachado', correr = modo !== 'agachado', pressCrouch = false;
      ctx.input.getMoveVector = (out) => { out.x = 0; out.y = 1; return out; };
      ctx.input.isDown = (a) => (a === 'crouch' ? agachar : a === 'sprint' ? correr : false);
      ctx.input.wasPressed = (a) => (a === 'crouch' ? pressCrouch : false);
      ctx.input.locked = true;

      let maxAlcance = -Infinity, fora = 0, caiu = 0, deslizou = 0, vMax = 0;
      for (let i = 0; i < 60 * 16; i++) {
        if (modo === 'deslizando') {
          /* Deslizar so entra com mais de 5 m/s no corpo e com o cooldown
           * vencido; fora do deslize, segue correndo para reganhar velocidade. */
          const rapido = jog.movement.planarSpeed > 5.4 && jog.movement.grounded;
          const jaDesliza = jog.movement.state === 'deslizando';
          pressCrouch = rapido && !jaDesliza;
          agachar = rapido || jaDesliza;
        }
        jog.update(1 / 60);
        pressCrouch = false;
        if (jog.movement.state === 'deslizando') deslizou++;
        if (jog.movement.planarSpeed > vMax) vMax = jog.movement.planarSpeed;
        const q = jog.position;
        const a = q.x * rumo.dx + q.z * rumo.dz;        // avanco no rumo pedido
        if (a > maxAlcance) maxAlcance = a;
        if (Math.abs(q.x) + RAIO > meia || Math.abs(q.z) + RAIO > meia) fora++;
        if (q.y < mundo.heightAt(q.x, q.z) - 1.5) caiu++;
      }
      saidas.push({
        rumo: rumo.nome, modo, lat: faixa.lat, faixaLivre: faixa.livres,
        alcance: +maxAlcance.toFixed(2),
        folga: +(meia - (maxAlcance + RAIO)).toFixed(2),
        encostou: maxAlcance >= limite - 0.25,
        fora, caiu, deslizou, vMax: +vMax.toFixed(1),
        alturaCapsula: +jog.movement.capsuleHeight.toFixed(2),
      });
    }
  }
  ctx.input.getMoveVector = origGMV;
  ctx.input.isDown = origDown;
  ctx.input.wasPressed = origPress;
  return saidas;
}, SO_FOTO ? [] : ['andando', 'agachado', 'deslizando']);

console.log('');
console.log('=== 2) ENCOSTANDO NA BORDA (16 s por tentativa) =======================');
console.log('  rumo         modo        faixa   eixo ate   folga  encostou  vmax  fora  desliz  quedas');
for (const s of encostar) {
  console.log(`  ${s.rumo}  ${s.modo.padEnd(11)}${String(s.lat).padStart(5)} m ${String(s.alcance).padStart(8)} m ${String(s.folga).padStart(6)} m`
    + `${(s.encostou ? 'sim' : 'NAO').padStart(9)} ${String(s.vMax).padStart(5)} ${String(s.fora).padStart(5)} `
    + `${String(s.deslizou).padStart(7)} ${String(s.caiu).padStart(7)}`);
}
console.log('');
checa('todo mundo chegou na parede', encostar.every((s) => s.encostou),
  encostar.filter((s) => !s.encostou).map((s) => s.rumo.trim() + '/' + s.modo).join(', ') || '');
checa('ninguem saiu dos limites', encostar.every((s) => s.fora === 0));
checa('ninguem caiu do mapa', encostar.every((s) => s.caiu === 0));
checa('o corpo sempre ficou sobre o terreno', encostar.every((s) => s.folga > 0),
  'menor folga ' + Math.min(...encostar.map((s) => s.folga)).toFixed(2) + ' m');
checa('deslizar realmente aconteceu nas 4 bordas',
  encostar.filter((s) => s.modo === 'deslizando').every((s) => s.deslizou > 25),
  encostar.filter((s) => s.modo === 'deslizando').map((s) => s.deslizou).join('/') + ' quadros deslizando');
checa('agachado tem outra forma de corpo', encostar.filter((s) => s.modo === 'agachado').every((s) => s.alturaCapsula < 1.2),
  encostar.find((s) => s.modo === 'agachado')?.alturaCapsula + ' m de capsula');

/* --------------------------------------------------------- 3) o que se ve */

const vista = await p.evaluate(() => {
  const ctx = window.__game.ctx, mundo = ctx.world;
  const meia = mundo.size * 0.5;
  const limite = mundo.muralha.faceInterna - 0.35;
  const fundoSaia = mundo.favela.cotaMin - 25;      // ver World._saiaTerreno

  /* NAO usa `collision.raycast` aqui, de proposito.
   *
   * A muralha E colisao: um raio horizontal saindo do olho de quem esta
   * encostado nela bate na parede invisivel a 35 cm e o teste responde "o chao
   * comeca a 0 grau" nas quatro bordas — que foi o que a primeira versao
   * relatou. O que importa nesta medicao e o que a CAMERA ve, e camera nao ve
   * barreira. Entao a sonda marcha contra o que esta na tela: o campo de altura
   * do terreno (mesma funcao que gera a malha visual) e a "saia" das bordas.
   *
   * A saia e uma cortina VERTICAL na aresta do mapa, so na malha visual: um
   * raio que sai do mapa a cruza se a altura no cruzamento estiver entre o
   * fundo dela e a cota do terreno na aresta. */
  const marchar = (ox, oy, oz, dx, dy, dz) => {
    let t = 0;
    while (t < 400) {
      const passo = t < 8 ? 0.05 : (t < 40 ? 0.25 : 1.0);
      t += passo;
      const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
      if (Math.abs(x) > meia || Math.abs(z) > meia) {
        // cruzou a aresta: bate na saia se estiver na altura dela
        const cx = Math.max(-meia, Math.min(meia, x)), cz = Math.max(-meia, Math.min(meia, z));
        const topo = mundo.heightAt(cx, cz);
        return (y <= topo && y >= fundoSaia) ? 'saia' : null;
      }
      if (y < mundo.heightAt(x, z)) return 'terreno';
      if (y < fundoSaia) return null;
    }
    return null;
  };

  const rumos = [
    { nome: 'norte (-Z)', dx: 0, dz: -1 },
    { nome: 'sul   (+Z)', dx: 0, dz: 1 },
    { nome: 'oeste (-X)', dx: -1, dz: 0 },
    { nome: 'leste (+X)', dx: 1, dz: 0 },
  ];
  const saidas = [];
  for (const r of rumos) {
    const px = r.dx * limite, pz = r.dz * limite;
    const chao = mundo.heightAt(px, pz);
    for (const [rotulo, olho] of [['de pe', 1.68], ['agachado', 0.95]]) {
      const oy = chao + olho;
      /* Varre de 0 (horizonte) para baixo. O chao "comeca" no primeiro angulo
       * em que a vista bate em alguma coisa; dali para baixo nao pode voltar a
       * ficar vazio, senao ha um rasgo entre o chao e o horizonte. */
      let anguloChao = null, vazioDepois = 0, oQueVe = null;
      for (let g = 0; g <= 89; g += 0.5) {
        const rad = g * Math.PI / 180;
        const dy = -Math.sin(rad), dh = Math.cos(rad);
        const bateu = marchar(px, oy, pz, r.dx * dh, dy, r.dz * dh);
        if (bateu && anguloChao === null) { anguloChao = g; oQueVe = bateu; }
        if (!bateu && anguloChao !== null) vazioDepois++;
      }
      saidas.push({
        rumo: r.nome, pose: rotulo, x: +px.toFixed(1), z: +pz.toFixed(1),
        cotaChao: +chao.toFixed(1), anguloChao, vazioDepois, oQueVe,
      });
    }
  }
  return saidas;
});

console.log('');
console.log('=== 3) O QUE SE VE DA BORDA ===========================================');
console.log('  (angulo abaixo do horizonte em que o chao aparece, olhando para FORA;');
console.log('   quanto MAIOR, mais o jogador precisa baixar a cabeca para ver a aresta)');
console.log('');
console.log('  rumo         pose        cota      chao aparece a   e o que aparece   rasgo depois');
for (const v of vista) {
  console.log(`  ${v.rumo}  ${v.pose.padEnd(9)} ${String(v.cotaChao).padStart(6)} m  `
    + `${v.anguloChao === null ? 'NUNCA' : ('-' + v.anguloChao.toFixed(1) + ' graus')}`.padStart(16)
    + `   ${String(v.oQueVe ?? '-').padEnd(16)}${v.vazioDepois === 0 ? 'nao' : v.vazioDepois + ' amostras'}`);
}
console.log('');
checa('o chao aparece olhando para baixo nas 4 bordas', vista.every((v) => v.anguloChao !== null));
checa('sem rasgo entre o chao e o horizonte', vista.every((v) => v.vazioDepois === 0));

/* ------------------------------------------------------------ 4) capturas */

mkdirSync(ROOT + '/shots/borda', { recursive: true });
const poses = await p.evaluate(() => {
  const mundo = window.__game.ctx.world;
  const limite = mundo.muralha.faceInterna - 0.35;
  /* A camera olha para -Z com yaw 0, entao o yaw que aponta para (dx,dz) e
   * `atan2(-dx, -dz)` — o MESMO de `Movement._fwd`. Escrito a mao, leste e
   * oeste saem trocados e a foto fica olhando para dentro do mapa (foi o que
   * aconteceu na primeira leva de capturas). */
  const olhando = (dx, dz) => Math.atan2(-dx, -dz) * 180 / Math.PI;
  return [
    { nome: 'norte', x: 0, z: -limite, yaw: olhando(0, -1) },
    { nome: 'sul', x: 0, z: limite, yaw: olhando(0, 1) },
    { nome: 'oeste', x: -limite, z: 0, yaw: olhando(-1, 0) },
    { nome: 'leste', x: limite, z: 0, yaw: olhando(1, 0) },
  ].map((o) => ({ ...o, y: mundo.heightAt(o.x, o.z) + 1.68 }));
});
/* O menu e DOM por cima do canvas: sem `hideAll` a foto sai da tela de titulo,
 * e nao do mundo. A primeira captura ainda assim e lixo por contrato. */
const compor = (o) => p.evaluate((q) => {
  const ctx = window.__game.ctx;
  ctx.menu?.hideAll?.();
  ctx.hud?.setVisible?.(false);
  ctx.viewScene.visible = false;
  ctx.state = 'pausado';         // o rAF nao pode mexer na camera depois disto
  ctx.camera.up.set(0, 1, 0);
  ctx.camera.position.set(q.x, q.y, q.z);
  ctx.camera.rotation.set(q.pitch * Math.PI / 180, q.yaw * Math.PI / 180, 0, 'YXZ');
  ctx.camera.fov = 75; ctx.camera.updateProjectionMatrix();
  ctx.camera.updateMatrixWorld(true);
  ctx.lighting?.update?.(0, ctx.time.elapsed);
  window.__game.settle(20);
}, o);

/* Dois pitches por borda, e os dois importam:
 *   -12 graus e a vista NORMAL de quem joga, e responde "isso parece quebrado?"
 *   -50 graus e a vista de quem BAIXA A CABECA, e responde "e o que tem ali?"
 * So a primeira nao bastaria: a -12 a aresta nem entra no quadro (o chao so
 * comeca por volta de -60), e a foto sairia igual com qualquer margem. */
await compor({ ...poses[0], pitch: -12 });
await p.screenshot();            // descartada: o menu ainda esta por cima
for (const pose of poses) {
  for (const [pitch, sufixo] of [[-12, 'olhando'], [-50, 'aresta']]) {
    await compor({ ...pose, pitch });
    const png = await p.screenshot();
    writeFileSync(`${ROOT}/shots/borda/${pose.nome}-${sufixo}.png`, png);
  }
}
console.log('');
console.log('  capturas em shots/borda/: *-olhando.png (pitch -12, vista de jogo)');
console.log('                            *-aresta.png  (pitch -50, cabeca baixa)');

await b.close(); vite.kill();
console.log('');
console.log(falhas === 0 ? '>>> OK' : '>>> ' + falhas + ' FALHA(S)');
process.exit(falhas === 0 ? 0 : 1);
