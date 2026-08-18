/**
 * piso.mjs — procura BURACO NO CHAO, com coordenada.
 *
 * Quatro medicoes independentes, porque uma sozinha mente:
 *
 * 1) COLUNA — grade sobre o `navGrid` inteiro. Para cada celula andavel, um raio
 *    de MUITO ACIMA de tudo para baixo. Coluna sem nenhuma interseccao e buraco
 *    de verdade: quem estiver ali cai para fora do mundo e nada o segura.
 *
 *    ARMADILHA JA PAGA: a primeira versao largava o raio de `plano + 0,6 m`. A
 *    colisao do terreno e DECIMADA (1 triangulo a cada 2 m) e sobe acima do
 *    plano em quina de plataforma achatada — o raio nascia DENTRO do morro,
 *    apontando para baixo, e nao batia em nada. Deu 40 "buracos" que nao
 *    existem. Raio de cima para baixo nao tem esse vies.
 *
 * 2) DE PE — a mesma celula testada com a CAPSULA do jogador (raio 0,35 m,
 *    altura 1,80 m): largada logo acima do piso achado, tem de terminar
 *    `grounded`. Raio acha triangulo; capsula responde se da para ficar em pe.
 *
 * O QUE REPROVA E O QUE SO INFORMA. So `vazio` e `afundado` sao queda para
 * fora do mundo, e so eles reprovam. `saliente` e `semapoio` sao RELEVO: a
 * celula andavel tem em cima dela um telhado, um beiral, uma caixa d'agua, um
 * carro ou um tronco — coisas que a malha (feita do PLANO) nao conhece e que a
 * colisao conhece. Contar isso como buraco enche o relatorio de mil linhas e
 * esconde a unica que importa.
 *
 * 3) TUNEL — capsula caindo na velocidade TERMINAL (55 m/s, o teto de
 *    `Movement`) com o pior `dt` do jogo (0,05 s). Se `capsuleSweep` deixa
 *    passar em velocidade alta, e aqui que aparece.
 *
 * 4) RASTRO — passeio de 25 s contra as quatro bordas, anotando o quadro exato
 *    em que o jogador passa a estar ABAIXO do plano do terreno. A varredura diz
 *    onde o chao falta; o rastro diz por onde ele entrou.
 *
 * Uso:  node tools/piso.mjs  [--json saida.json]
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const ROOT = process.cwd(), PORT = Number(process.env.PORT ?? 5281);
const argJson = process.argv.indexOf('--json');
const SAIDA = argJson > 0 ? process.argv[argJson + 1] : null;

const vite = spawn(process.execPath, [ROOT + '/node_modules/vite/bin/vite.js', '--config', 'tools/vite.diag.config.js', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r, j) => { const t = setTimeout(() => j(new Error('t/o')), 60000); vite.stdout.on('data', d => { if (/ready in|Local:/i.test(String(d))) { clearTimeout(t); r(); } }); });
const b = await chromium.launch({ headless: true, executablePath: process.env.PW_CHROME || undefined, args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', e => console.log('PAGEERR:', String(e).split('\n')[0]));
await p.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load', timeout: 120000 });
await p.waitForFunction(() => window.__game?.ready, undefined, { timeout: 240000 });
await p.waitForTimeout(800);

/* --------------------------------------------- 1..3) varredura da grade */

const varredura = await p.evaluate(() => {
  const ctx = window.__game.ctx, mundo = ctx.world, col = mundo.collision, ng = mundo.navGrid;
  /* `raycast`/`capsuleSweep` so leem .x/.y/.z: objeto simples serve e evita
   * depender do THREE dentro do evaluate. */
  const O = { x: 0, y: 0, z: 0 }, D = { x: 0, y: -1, z: 0 };
  const A = { x: 0, y: 0, z: 0 }, B = { x: 0, y: 0, z: 0 };
  const RAIO = 0.35, ALTURA = 1.80;

  /* Teto da sonda: ABAIXO do topo da muralha invisivel. Largando mais alto, o
   * raio de cima para baixo acerta a TAMPA da muralha (que atravessa o mapa
   * inteiro de ponta a ponta) e o mundo inteiro le como "piso a 65,7 m". */
  const ALTO = (mundo.muralha?.topo ?? (mundo.favela.cotaMax + 30)) - 1.0;
  const FUNDO = mundo.favela.cotaMin - 80;

  /** Casa (ou muro) cobrindo (x,z)? Piso acima do plano ali e telhado, nao defeito. */
  const emObb = (x, z, o, margem) => {
    const c = Math.cos(o.yaw), s = Math.sin(o.yaw);
    const dx = x - o.x, dz = z - o.z;
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    return Math.abs(lx) <= o.w * 0.5 + margem && Math.abs(lz) <= o.d * 0.5 + margem;
  };
  const sobConstrucao = (x, z) => {
    for (const c of mundo.favela.casas) if (emObb(x, z, c, 1.2)) return true;
    for (const m of mundo.favela.muros) if (emObb(x, z, { x: m.x, z: m.z, w: m.len, d: 0.3, yaw: m.yaw }, 0.6)) return true;
    return false;
  };

  const falhas = [];
  let andaveis = 0, somaDif = 0, maxDif = 0, maxDifEm = null;
  const hist = { '<-0.75': 0, '-0.75..-0.25': 0, '-0.25..0.25': 0, '0.25..0.75': 0, '>0.75': 0 };

  for (let j = 0; j < ng.height; j++) {
    for (let i = 0; i < ng.width; i++) {
      if (!ng.isWalkable(i, j)) continue;              // ATENCAO: indices de CELULA
      andaveis++;
      const x = ng.origin.x + (i + 0.5) * ng.cellSize;
      const z = ng.origin.z + (j + 0.5) * ng.cellSize;
      const hPlano = ng.heightAt(i, j);

      // --- 1) coluna: existe QUALQUER coisa embaixo? ---
      O.x = x; O.y = ALTO; O.z = z;
      const r = col.raycast(O, D, ALTO - FUNDO);
      // devolve SEMPRE o mesmo objeto: copiar antes do proximo raio
      const bateu = r.hit, yTopo = bateu ? r.point.y : NaN, nyTopo = bateu ? r.normal.y : 0;

      if (!bateu) {
        falhas.push({ i, j, x: +x.toFixed(2), z: +z.toFixed(2), h: +hPlano.toFixed(2), tipo: 'vazio', y: null, ny: null });
        continue;
      }

      const dif = yTopo - hPlano;
      somaDif += Math.abs(dif);
      if (Math.abs(dif) > Math.abs(maxDif)) { maxDif = dif; maxDifEm = [+x.toFixed(1), +z.toFixed(1)]; }
      if (dif < -0.75) hist['<-0.75']++;
      else if (dif < -0.25) hist['-0.75..-0.25']++;
      else if (dif <= 0.25) hist['-0.25..0.25']++;
      else if (dif <= 0.75) hist['0.25..0.75']++;
      else hist['>0.75']++;

      // --- 2) de pe: a capsula para em cima disso? ---
      A.x = x; A.y = yTopo + 0.45; A.z = z;
      B.x = x; B.y = yTopo - 0.35; B.z = z;
      const cs = col.capsuleSweep(A, B, RAIO, ALTURA, 0.40);
      if (!cs.grounded) {
        falhas.push({
          i, j, x: +x.toFixed(2), z: +z.toFixed(2), h: +hPlano.toFixed(2),
          tipo: 'semapoio', y: +yTopo.toFixed(2), ny: +nyTopo.toFixed(2),
        });
        continue;
      }

      // piso muito abaixo do plano e queda escondida; muito acima so vale fora de casa
      if (dif < -1.20) {
        falhas.push({ i, j, x: +x.toFixed(2), z: +z.toFixed(2), h: +hPlano.toFixed(2), tipo: 'afundado', y: +yTopo.toFixed(2), ny: +nyTopo.toFixed(2) });
      } else if (dif > 1.20 && !sobConstrucao(x, z)) {
        falhas.push({ i, j, x: +x.toFixed(2), z: +z.toFixed(2), h: +hPlano.toFixed(2), tipo: 'saliente', y: +yTopo.toFixed(2), ny: +nyTopo.toFixed(2) });
      }
    }
  }

  /* --- agrupa celulas vizinhas num so ponto de relatorio --- */
  const chave = (i, j) => i * 100000 + j;
  const mapa = new Map(falhas.map((f) => [chave(f.i, f.j), f]));
  const visto = new Set();
  const grupos = [];
  for (const f of falhas) {
    const k0 = chave(f.i, f.j);
    if (visto.has(k0)) continue;
    const pilha = [f], membros = [];
    visto.add(k0);
    while (pilha.length) {
      const c = pilha.pop();
      membros.push(c);
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const k = chave(c.i + di, c.j + dj);
        if (visto.has(k)) continue;
        const viz = mapa.get(k);
        if (!viz || viz.tipo !== c.tipo) continue;
        visto.add(k); pilha.push(viz);
      }
    }
    let sx = 0, sz = 0;
    for (const m of membros) { sx += m.x; sz += m.z; }
    grupos.push({
      n: membros.length, tipo: membros[0].tipo,
      cx: +(sx / membros.length).toFixed(1), cz: +(sz / membros.length).toFixed(1),
      area: +(membros.length * ng.cellSize * ng.cellSize).toFixed(1),
      h: membros[0].h, y: membros[0].y, ny: membros[0].ny,
    });
  }
  grupos.sort((a, b) => b.n - a.n);

  /* --- 3) tunel: capsula em velocidade terminal, pior dt --- */
  const passos = [];
  const VT = 55, DT = 0.05;                        // teto de queda x pior quadro
  let amostras = 0, vazou = 0;
  const piorCaso = [];
  for (let j = 2; j < ng.height - 2; j += 7) {
    for (let i = 2; i < ng.width - 2; i += 7) {
      if (!ng.isWalkable(i, j)) continue;
      const x = ng.origin.x + (i + 0.5) * ng.cellSize;
      const z = ng.origin.z + (j + 0.5) * ng.cellSize;
      O.x = x; O.y = ALTO; O.z = z;
      const r = col.raycast(O, D, ALTO - FUNDO);
      if (!r.hit) continue;
      const yTopo = r.point.y;
      amostras++;
      // solta 6 m acima e cai em VT ate cruzar o piso
      let py = yTopo + 6, chegou = false;
      for (let k = 0; k < 8; k++) {
        A.x = x; A.y = py; A.z = z;
        B.x = x; B.y = py - VT * DT; B.z = z;
        const cs = col.capsuleSweep(A, B, RAIO, ALTURA, 0.40);
        py = cs.position.y;
        if (cs.grounded || py >= yTopo - 0.5) { chegou = cs.grounded || py > yTopo - 0.5; }
        if (cs.grounded) { chegou = true; break; }
        if (py < yTopo - 2.0) break;
      }
      if (!chegou) { vazou++; if (piorCaso.length < 12) piorCaso.push([+x.toFixed(1), +z.toFixed(1), +yTopo.toFixed(1), +py.toFixed(1)]); }
    }
  }
  void passos;

  const GRAVES = new Set(['vazio', 'afundado']);
  return {
    andaveis, celulas: ng.width * ng.height, cel: ng.cellSize,
    falhas: falhas.length,
    graves: falhas.filter((f) => GRAVES.has(f.tipo)).length,
    grupos: grupos.filter((g) => GRAVES.has(g.tipo)).slice(0, 40),
    gruposAviso: grupos.filter((g) => !GRAVES.has(g.tipo)).slice(0, 8),
    porTipo: falhas.reduce((a, f) => (a[f.tipo] = (a[f.tipo] || 0) + 1, a), {}),
    difMedia: +(somaDif / Math.max(1, andaveis)).toFixed(3), maxDif: +maxDif.toFixed(2), maxDifEm, hist,
    tunel: { amostras, vazou, piorCaso },
    cotaMin: mundo.favela.cotaMin, cotaMax: mundo.favela.cotaMax, size: mundo.size,
    trisColisao: mundo.collision.triangleCount,
  };
});

const V = varredura;
console.log('');
console.log('=== 1) COLUNA / 2) DE PE ==============================================');
console.log(`  mapa +-${(V.size / 2).toFixed(0)} m   cota ${V.cotaMin.toFixed(1)} .. ${V.cotaMax.toFixed(1)} m   ${V.trisColisao} tris de colisao`);
console.log(`  celulas andaveis: ${V.andaveis} de ${V.celulas} (${V.cel} m)`);
console.log(`  marcacoes: ${V.falhas}   ${JSON.stringify(V.porTipo)}`);
console.log('');
console.log(`  >> BURACO DE VERDADE (cai para fora do mundo): ${V.graves} celula(s)`);
if (V.grupos.length) {
  console.log('  tipo      celulas    area      centro (x, z)     cota plano   piso achado');
  for (const g of V.grupos) {
    console.log(`  ${g.tipo.padEnd(9)}${String(g.n).padStart(5)} cel ${String(g.area).padStart(7)} m2  `
      + `X=${String(g.cx).padStart(7)} Z=${String(g.cz).padStart(7)}  `
      + `${String(g.h).padStart(8)} m  ${g.y === null ? '   (nada)' : String(g.y).padStart(8) + ' m'}`);
  }
} else console.log('     nenhuma. Toda celula andavel tem chao embaixo.');
console.log('');
console.log('  (informativo) celula andavel com COISA em cima — telhado, beiral, caixa');
console.log("  d'agua, veiculo, tronco. Nao e buraco; e o mundo em pe sobre a malha:");
for (const g of V.gruposAviso) {
  console.log(`  ${g.tipo.padEnd(9)}${String(g.n).padStart(5)} cel ${String(g.area).padStart(7)} m2  `
    + `X=${String(g.cx).padStart(7)} Z=${String(g.cz).padStart(7)}  `
    + `${String(g.h).padStart(8)} m  ${g.y === null ? '   (nada)' : String(g.y).padStart(8) + ' m'}`);
}

console.log('');
console.log('  colisao do terreno x plano do terreno (piso achado menos cota do plano):');
console.log(`    |dif| media ${V.difMedia} m   pior ${V.maxDif} m em X=${V.maxDifEm?.[0]} Z=${V.maxDifEm?.[1]}`);
console.log(`    ${JSON.stringify(V.hist)}`);
console.log('');
console.log('=== 3) TUNEL (queda a 55 m/s, dt 0,05 s) ==============================');
console.log(`  ${V.tunel.amostras} pontos testados, ${V.tunel.vazou} atravessaram o piso`);
for (const c of V.tunel.piorCaso) console.log(`    X=${c[0]} Z=${c[1]}  piso ${c[2]} m  parou em ${c[3]} m`);

/* --------------------------------------------------------------- 4) RASTRO */

const rastro = await p.evaluate(async () => {
  const ctx = window.__game.ctx, jog = ctx.player, mundo = ctx.world;
  ctx.state = 'jogando';
  const meia = mundo.size * 0.5;
  const rumos = [
    { nome: 'norte (-Z)', dx: 0, dz: -1 },
    { nome: 'sul   (+Z)', dx: 0, dz: 1 },
    { nome: 'oeste (-X)', dx: -1, dz: 0 },
    { nome: 'leste (+X)', dx: 1, dz: 0 },
  ];
  const saidas = [];

  for (const rumo of rumos) {
    const px = rumo.dx * (meia - 12), pz = rumo.dz * (meia - 12);
    const hLargada = mundo.heightAt(px, pz);
    jog.destravar?.();
    /* Largada ACIMA DO CHAO DAQUELE PONTO. Cota fixa nao serve: o morro tem
     * 39 m de desnivel e a borda sul esta 36 m acima da cota minima. */
    jog.movement.teleport(px, hLargada + 3, pz);
    jog.movement.velocity.set(0, 0, 0);
    // sem escrever o yaw, "para a frente" e o lado sorteado no Player.init()
    jog.rig.reset(Math.atan2(-rumo.dx, -rumo.dz), 0);
    for (let i = 0; i < 90; i++) jog.update(1 / 60);

    const orig = ctx.input.getMoveVector.bind(ctx.input);
    ctx.input.getMoveVector = (out) => { out.x = 0; out.y = 1; return out; };
    ctx.input.locked = true;

    const anel = new Array(40).fill(null);
    let k = 0, evento = null, menorY = Infinity;

    for (let i = 0; i < 60 * 25; i++) {
      jog.update(1 / 60);
      const q = jog.position;
      const hPlano = mundo.heightAt(q.x, q.z);
      if (q.y < menorY) menorY = q.y;
      anel[k % anel.length] = { i, x: +q.x.toFixed(2), y: +q.y.toFixed(2), z: +q.z.toFixed(2), h: +hPlano.toFixed(2), g: jog.movement.grounded, v: +jog.movement.velocity.y.toFixed(1) };
      k++;
      if (!evento && q.y < hPlano - 1.5) {
        const janela = [];
        for (let s = 0; s < anel.length; s++) { const e = anel[(k + s) % anel.length]; if (e) janela.push(e); }
        evento = { quadro: i, x: +q.x.toFixed(2), y: +q.y.toFixed(2), z: +q.z.toFixed(2), h: +hPlano.toFixed(2), janela };
      }
    }
    ctx.input.getMoveVector = orig;
    saidas.push({
      rumo: rumo.nome, largadaX: +px.toFixed(1), largadaZ: +pz.toFixed(1),
      cotaLargada: +hLargada.toFixed(1), menorY: +menorY.toFixed(1),
      fim: { x: +jog.position.x.toFixed(1), z: +jog.position.z.toFixed(1), y: +jog.position.y.toFixed(1) },
      evento,
    });
  }
  return saidas;
});

console.log('');
console.log('=== 4) RASTRO: o jogador ficou abaixo do terreno? =====================');
for (const s of rastro) {
  console.log(`  ${s.rumo}  largada X=${s.largadaX} Z=${s.largadaZ} (terreno ${s.cotaLargada} m)`
    + `  fim X=${s.fim.x} Z=${s.fim.z} Y=${s.fim.y}  menorY=${s.menorY}`);
  if (!s.evento) { console.log('      nunca ficou abaixo do terreno.'); continue; }
  const e = s.evento;
  console.log(`      MERGULHOU no quadro ${e.quadro} em X=${e.x} Z=${e.z}  (y=${e.y}, plano=${e.h})`);
  console.log('        quadro       X        Y        Z    plano   noChao      vY');
  for (const f of e.janela.slice(-26)) {
    console.log(`     ${String(f.i).padStart(9)}${String(f.x).padStart(9)}${String(f.y).padStart(9)}${String(f.z).padStart(9)}`
      + `${String(f.h).padStart(9)}   ${f.g ? 'sim' : 'NAO'}${String(f.v).padStart(8)}`);
  }
}

if (SAIDA) {
  writeFileSync(SAIDA, JSON.stringify({ varredura, rastro }, null, 1));
  console.log('\n  json em ' + SAIDA);
}

await b.close(); vite.kill();
const ok = V.graves === 0 && V.tunel.vazou === 0 && rastro.every((s) => !s.evento);
console.log('');
console.log(ok ? '>>> OK' : '>>> HA BURACO');
process.exit(ok ? 0 : 1);
