/**
 * porquetrava.mjs — nos pontos que AINDA travam, qual condicao do degrau
 * automatico falha.
 *
 * O `capsuleSweep` so sobe a aresta se TODAS estas passarem:
 *   1. pedidoH > 0,002          houve intencao de andar
 *   2. obtidoH < pedidoH*0,85   o plano barrou
 *   3. `_depenetrate` == 0 em `start.y + stepHeight`   cabe la em cima
 *   4. `marchar` do ponto elevado anda mais que o do plano
 *   5. `_sondaChao` acha patamar, e ele esta entre `start.y - 0,6` e
 *      `start.y + stepHeight + 0,02`
 *
 * Cada uma reprova por um motivo diferente e pede um conserto diferente. Sem
 * separar, "melhorar o degrau" vira chute. Os metodos privados sao grampeados
 * durante UM quadro para saber qual delas falou.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const ROOT = process.cwd(), PORT = Number(process.env.PORT ?? 5297);
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const ENTRADA = arg('de', 'tools/meiofio.depois.json');
const SAIDA = arg('json', null);
/* --dec N regenera o mundo com `World.DEC_COLISAO_TERRENO = N` antes de medir.
 * E assim que a segunda hipotese (colisao de 2 m contra malha visual de 1 m)
 * responde por MEDICAO, com o mesmo instrumento dos dois lados. */
const DEC = arg('dec', null);

const vite = spawn(process.execPath, [ROOT + '/node_modules/vite/bin/vite.js', '--config', 'tools/vite.diag.config.js', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r, j) => { const t = setTimeout(() => j(new Error('t/o')), 60000); vite.stdout.on('data', d => { if (/ready in|Local:/i.test(String(d))) { clearTimeout(t); r(); } }); });
const b = await chromium.launch({ headless: true, executablePath: process.env.PW_CHROME || undefined, args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', e => console.log('PAGEERR:', String(e).split('\n')[0]));
await p.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load', timeout: 120000 });
await p.waitForFunction(() => window.__game?.ready, undefined, { timeout: 240000 });
await p.waitForTimeout(800);

if (DEC) {
  await p.evaluate(async (dec) => {
    const ctx = window.__game.ctx;
    const { World } = await import('/src/world/World.js');
    const antes = ctx.world;
    World.DEC_COLISAO_TERRENO = Number(dec);
    const w = new World(ctx, { seed: antes.seed, size: antes.size });
    await w.init();
    ctx.scene.remove(antes.group);
    antes.dispose?.();
    ctx.scene.add(w.group);
    ctx.world = w;
  }, DEC);
  console.log('  mundo regerado com DEC_COLISAO_TERRENO = ' + DEC);
}

const r = await p.evaluate(() => {
  const ctx = window.__game.ctx, mundo = ctx.world, col = mundo.collision, ng = mundo.navGrid;
  const O = { x: 0, y: 0, z: 0 }, D = { x: 0, y: -1, z: 0 }, U = { x: 0, y: 1, z: 0 };
  const R = 0.35, H = 1.80, STEP = 0.45, LIM = R * 0.5;
  const ALTO = (mundo.muralha?.topo ?? mundo.favela.cotaMax + 30) - 1.0;
  const FUNDO = mundo.favela.cotaMin - 80;
  const piso = (x, z, deY) => { O.x = x; O.y = deY; O.z = z; const h = col.raycast(O, D, deY - FUNDO); return h.hit ? { y: h.point.y, sup: h.surface, ny: h.normal.y } : null; };
  const cabeDePe = (x, y, z) => { O.x = x; O.y = y + 0.10; O.z = z; return !col.raycast(O, U, H - 0.12).hit; };

  /* --- grampo nos metodos privados: qual condicao falou neste quadro --- */
  const depOrig = col._depenetrate.bind(col);
  const sonOrig = col._sondaChao.bind(col);
  let diag = null;
  col._depenetrate = (pos, radius, height, normalOut) => {
    const n = depOrig(pos, radius, height, normalOut);
    if (diag) diag.dep.push(n);
    return n;
  };
  col._sondaChao = (pos, radius, alcance, res) => {
    const ok = sonOrig(pos, radius, alcance, res);
    if (diag) diag.son.push({ alc: +alcance.toFixed(2), ok, y: ok ? +res.y.toFixed(3) : null });
    return ok;
  };

  const A = { x: 0, y: 0, z: 0 }, B = { x: 0, y: 0, z: 0 };
  const REINI = 11.0 * 4.3 / 3600;
  /* INVARIANTE: um quadro nunca pode levantar a capsula mais que `stepHeight`.
   * E o que separa "degrau automatico" de "escalar muro"; qualquer conserto no
   * ramo do degrau tem de manter isto, e o numero sai de graca da marcha. */
  const salto = { pior: 0, x: 0, z: 0 };
  /* `_depenetrate` e `_sondaChao` mexem em Vector3 DE VERDADE (addScaledVector,
   * copy). Objeto simples serve para `raycast`, nao para eles. */
  const V3 = ctx.camera.position.constructor;
  const _alt = new V3(), _nrm = new V3(), _sondaRes = { y: 0, normal: new V3(), surface: '' };

  /** Anda contra a aresta e, no quadro travado, diz por que o degrau nao subiu. */
  const investigar = (x, z, dx, dz) => {
    const base = piso(x - dx * 0.9, z - dz * 0.9, ALTO);
    if (!base) return null;
    let px = x - dx * 0.9, py = base.y + 0.02, pz = z - dz * 0.9, vel = 4.3, parado = 0;
    for (let k = 0; k < 45; k++) {
      const passo = vel / 60;
      A.x = px; A.y = py; A.z = pz;
      B.x = px + dx * passo; B.y = py - 2.0 / 60; B.z = pz + dz * passo;
      diag = { dep: [], son: [] };
      const cs = col.capsuleSweep(A, B, R, H);
      const d = diag; diag = null;
      const av = (cs.position.x - px) * dx + (cs.position.z - pz) * dz;
      const dY = cs.position.y - py;
      if (dY > salto.pior) { salto.pior = dY; salto.x = +cs.position.x.toFixed(2); salto.z = +cs.position.z.toFixed(2); }
      px = cs.position.x; py = cs.position.y; pz = cs.position.z;
      if (av < passo * 0.25) { parado++; vel = REINI * 60; } else { parado = 0; vel = 4.3; }
      if (parado < 10) continue;

      /* travado. Refaz as condicoes do ramo com o estado deste quadro.
       *
       * ARMADILHA JA PAGA: medir o piso a frente com um raio largado a
       * `aqui.y + 1,4` mente na presenca de PAREDE. Acima de 1,4 m o raio nasce
       * DENTRO do bloco da casa e o `raycastFirst` de face dupla devolve a face
       * de BAIXO da caixa (ou o terreno sob ela) — a parede de 3 m lia como
       * "sobe 0,0 m" e ia parar no balde de "aresta baixa que travou". Eram
       * 1 972 de 2 463. O topo do obstaculo se mede como o `tools/degrau.mjs`
       * mede: de MUITO acima, um pouco alem da face. */
      const startY = py;
      const aqui = piso(px, pz, ALTO);
      /* SEGUNDA ARMADILHA, tambem paga: medir o degrau SO a 0,6 m subestima.
       * A capsula para com o eixo a ~0,31 m da face (raio 0,35 menos a mordida
       * da aresta), e dali para frente o terreno pode voltar a descer. Na
       * coordenada do relato o degrau vale +0,225 m a 0,35 m e so +0,123 m a
       * 0,60 m: medido a 0,6 m ele caia no balde "aresta baixa (<=0,175)".
       * O degrau que vale e o MAIOR do perfil, com a distancia onde ele esta. */
      let frente = null, sobe = null, dFrente = 0.6;
      if (aqui) {
        for (const d of [0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.60]) {
          const f = piso(px + dx * d, pz + dz * d, ALTO);
          if (!f) continue;
          const alt = f.y - aqui.y;
          if (sobe === null || alt > sobe) { sobe = alt; frente = f; dFrente = d; }
        }
      }
      // 3) cabe la em cima?
      _alt.set(px, startY + STEP, pz);
      const nDep = depOrig(_alt, R, H, _nrm);
      // 5) ha patamar dentro da faixa aceita?
      const res = _sondaRes;
      _alt.set(px + dx * 0.02, startY + STEP, pz + dz * 0.02);
      const achou = sonOrig(_alt, R, STEP + 0.25, res);
      // patamar util: cabe em pe em cima do topo do obstaculo?
      const teto = frente ? cabeDePe(px + dx * dFrente, frente.y, pz + dz * dFrente) : false;

      /* QUEM barra, medido na horizontal. A sonda de piso e uma LINHA no eixo
       * da marcha; o corpo tem 0,70 m de largura. Poste, quina de casa ou
       * carro a 30 cm do lado barram sem aparecer no perfil, e o caso cai no
       * balde de "aresta baixa" sem que exista aresta nenhuma. Estes raios
       * dizem em que ALTURA esta o que empurra, e ate onde ele sobe. */
      const F = { x: dx, y: 0, z: dz };
      const ALTURAS = [0.05, 0.15, 0.25, 0.35, 0.55, 0.90, 1.40, 1.70];
      let topoBloqueio = null, baseBloqueio = null, supBloqueio = null;
      for (const h of ALTURAS) {
        O.x = px; O.y = startY + h; O.z = pz;
        const rb = col.raycast(O, F, 0.75);
        if (!rb.hit) continue;
        if (baseBloqueio === null) { baseBloqueio = h; supBloqueio = rb.surface; }
        topoBloqueio = h;
      }
      // e de lado? dois raios a 30 cm do eixo, na altura do joelho
      const perpX = -dz, perpZ = dx;
      let ladoBloqueio = false;
      for (const lado of [-0.30, 0.30]) {
        O.x = px + perpX * lado; O.y = startY + 0.25; O.z = pz + perpZ * lado;
        if (col.raycast(O, F, 0.75).hit) ladoBloqueio = true;
      }
      return {
        x: +px.toFixed(2), z: +pz.toFixed(2), y: +startY.toFixed(3),
        sobe: sobe === null ? null : +sobe.toFixed(3), dFrente, supFrente: frente?.sup ?? null, nyFrente: frente ? +frente.ny.toFixed(2) : null,
        supAqui: aqui?.sup ?? null,
        topoBloqueio, baseBloqueio, supBloqueio, ladoBloqueio,
        cabeEmCima: nDep === 0, contatosEmCima: nDep,
        patamar: achou ? +res.y.toFixed(3) : null,
        limiteAceito: +(startY + STEP + 0.02).toFixed(3),
        patamarNaFaixa: achou ? (res.y <= startY + STEP + 0.02 && res.y >= startY - 0.6) : false,
        pedirDeDe: teto,
        sondas: d.son, deps: d.dep,
      };
    }
    return null;
  };

  /* --- varre o mapa procurando travas e classifica o motivo --- */
  const CARD = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const motivos = {};
  const casos = [];
  const baixaPorTopo = {};
  const baixaExemplos = [];
  let testados = 0;
  for (let j = 2; j < ng.height - 2; j += 5) {
    for (let i = 2; i < ng.width - 2; i += 5) {
      if (!ng.isWalkable(i, j)) continue;
      const x = ng.origin.x + (i + 0.5) * ng.cellSize;
      const z = ng.origin.z + (j + 0.5) * ng.cellSize;
      for (const [dx, dz] of CARD) {
        const inv = investigar(x, z, dx, dz);
        if (!inv) continue;
        testados++;
        let motivo;
        if (inv.sobe === null) motivo = 'sem piso a frente';
        else if (inv.sobe > STEP) motivo = `PAREDE / degrau alto de verdade (> ${STEP} m)`;
        else if (!inv.pedirDeDe) motivo = 'sem pe-direito em cima do patamar';
        else if (!inv.cabeEmCima) motivo = 'nao cabe em pe no ponto elevado';
        else if (!inv.patamar) motivo = 'sonda de chao nao acha patamar';
        else if (!inv.patamarNaFaixa) motivo = 'patamar fora da faixa aceita';
        else if (inv.sobe <= LIM) motivo = 'aresta baixa (<=0,175) e mesmo assim travou';
        else motivo = 'aresta 0,175..0,45 com patamar bom — DEFEITO';
        motivos[motivo] = (motivos[motivo] || 0) + 1;
        if (motivo.startsWith('aresta baixa')) {
          const t = inv.topoBloqueio;
          const rot = t === null ? 'nada barra na linha do eixo'
            : t >= 1.40 ? 'bloqueio ate 1,4 m ou mais (parede/poste)'
              : t >= 0.55 ? 'bloqueio ate 0,55..0,90 m (muro baixo, carro)'
                : 'bloqueio so ate 0,35 m (aresta mesmo)';
          baixaPorTopo[rot] = (baixaPorTopo[rot] || 0) + 1;
          // exemplos POR categoria: sem isso a borda do mapa (788 casos de
          // muralha) come as 14 vagas e o balde que interessa fica sem endereco
          const jaTem = baixaExemplos.filter((e) => e.rot === rot).length;
          if (jaTem < 10) baixaExemplos.push({ x: inv.x, z: inv.z, sobe: inv.sobe, topo: t, base: inv.baseBloqueio, sup: inv.supBloqueio, lado: inv.ladoBloqueio, rot });
        }
        if (motivo.includes('DEFEITO') && casos.length < 25) casos.push({ ...inv, motivo, dx, dz });
      }
    }
  }

  col._depenetrate = depOrig; col._sondaChao = sonOrig;
  return { testados, motivos, casos, baixaPorTopo, baixaExemplos, salto: { pior: +salto.pior.toFixed(3), x: salto.x, z: salto.z }, trisColisao: col.triangleCount, trisTerrenoCol: mundo._trisTerrenoCol ?? null };
});

console.log(`\n=== por que ainda trava (${r.testados} travas classificadas) ==========`);
for (const [m, n] of Object.entries(r.motivos).sort((a, c) => c[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${m}`);
console.log('\n  o balde "aresta baixa e mesmo assim travou", aberto por QUEM barra:');
for (const [k, n] of Object.entries(r.baixaPorTopo || {}).sort((a, c) => c[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${k}`);
for (const rot of Object.keys(r.baixaPorTopo || {})) {
  console.log('    -- ' + rot);
  for (const c of (r.baixaExemplos || []).filter((e) => e.rot === rot).slice(0, 8)) {
    console.log(`    X=${String(c.x).padStart(8)} Z=${String(c.z).padStart(8)}  sobe ${c.sobe}  bloqueio ${c.base}..${c.topo} m (${c.sup})${c.lado ? '  + de lado' : ''}`);
  }
}

console.log('\n  casos que continuam sendo defeito:');
for (const c of r.casos.slice(0, 20)) {
  console.log(`    X=${String(c.x).padStart(8)} Z=${String(c.z).padStart(8)}  sobe ${c.sobe} m  ${c.supAqui} -> ${c.supFrente} (ny ${c.nyFrente})`
    + `  cabeEmCima=${c.cabeEmCima} patamar=${c.patamar} (limite ${c.limiteAceito})`);
}
console.log(`\n  maior subida num unico quadro: ${r.salto.pior} m (limite de degrau 0,45) em X=${r.salto.x} Z=${r.salto.z}`);
console.log(`  triangulos de colisao: ${r.trisColisao}   (terreno: ${r.trisTerrenoCol})`);
if (SAIDA) { writeFileSync(SAIDA, JSON.stringify(r, null, 1)); console.log('\n  json em ' + SAIDA); }
await b.close(); vite.kill();
void ENTRADA;
