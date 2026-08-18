/**
 * Mede quanto tempo o hostil leva para NOTAR e para ATIRAR num jogador que esta
 * a vista, com linha de visada livre.
 *
 * ---------------------------------------------------------------------------
 * DEFEITO DO INSTRUMENTO QUE ESTA VERSAO CORRIGE (medido, nao suposto)
 * ---------------------------------------------------------------------------
 * A versao anterior media o alvo ERRADO. `Perception` mira em
 * `ctx.player.eyePosition`, que e `player.rig.worldPosition` — e esse vetor so
 * e escrito dentro de `CameraRig.update()`, chamado por `Player.update()`.
 * A ferramenta punha `ctx.state = 'jogando'` e rodava so `ai.update()` num laco
 * sincrono; o laco de rAF fica bloqueado durante um `page.evaluate`, entao
 * `Player.update()` NUNCA rodava e `worldPosition` continuava (0, 0, 0).
 *
 * Consequencia medida: o hostil enxergava um fantasma na origem do mundo
 * (dentro do morro, a ~72 m do jogador). Dai vinham os tres numeros estranhos
 * do laudo anterior — `dist=71.8` no primeiro quadro, `ang=66` com o hostil
 * nascido olhando exatamente para o jogador, e "nunca notou" a 6 e 12 m.
 * A hipotese de que `ai.spawn()` errava o ponto era falsa: o spawn cai onde se
 * pede (conferido abaixo, cenario a cenario).
 *
 * O que mais estava furado e foi corrigido:
 *  - `for (e of pool) e.despawn()` nao limpa `ai.vivos`; o hostil novo entrava
 *    DUAS vezes na lista e era atualizado duas vezes por quadro. Agora usa
 *    `ai.reset()`.
 *  - com `ctx.state = 'jogando'` e `spawnAutomatico` ligado, o proprio
 *    `ai.update()` fazia nascer ondas no meio da medicao (5 hostis ao fim de
 *    5 s). Agora ondas e `Progressao` ficam desligadas.
 *  - o ponto do hostil era "d metros a frente do jogador" sem checar chao,
 *    navGrid nem visada: podia cair dentro de casa. Agora o posto e procurado
 *    e a visada e conferida ANTES de medir.
 *  - o perfil de dificuldade era o que a `Progressao` tivesse deixado no pool.
 *    Agora e fixado e impresso.
 *
 * ---------------------------------------------------------------------------
 * O QUE SE MEDE
 * ---------------------------------------------------------------------------
 * A) sentinela parada: hostil sem rota, jogador parado e em silencio absoluto.
 *    Tres rumos: de frente (0), de lado (90) e de costas (180) em relacao ao
 *    jogador. E o pior caso — nenhum som, nenhum movimento, so visao.
 * B) ronda natural: hostil com a rota que o proprio jogo monta.
 * C) passeio: o relato original ("fico passeando na frente dele"). O jogador
 *    anda de verdade, pelo `Player.update()`, em circulo, com passo audivel.
 *
 * Uso: node tools/reacao.mjs
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 5276);
const ONDA = Number(process.env.ONDA ?? 1);      // perfil de dificuldade medido
const DURACAO = Number(process.env.DURACAO ?? 25);

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
await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready, undefined, { timeout: 240000 });
await page.waitForTimeout(1500);

const r = await page.evaluate(async ({ ONDA, DURACAO }) => {
  const ctx = window.__game.ctx;
  const jog = ctx.player;
  const ai = ctx.ai;
  const col = ctx.world.collision;
  const dt = 1 / 60;
  const OLHO_HOSTIL = 1.62;

  /* --- silencia tudo que povoaria o campo por baixo da medicao --- */
  ctx.state = 'pausado';            // o laco de rAF nao simula nada
  ai.spawnAutomatico = false;
  if (ctx.progressao) ctx.progressao.fase = 'fim';
  ai.reset();

  /* --- perfil de dificuldade fixado e declarado --- */
  const perfil = ctx.progressao?.perfilDaOnda?.(ONDA) ?? null;
  if (perfil) for (const e of ai.pool) e.dif = perfil;

  /* Um unico quadro de jogador para o rig publicar `worldPosition`. Sem isto o
   * olho do jogador fica na origem do mundo — o defeito que motivou a revisao. */
  jog.update(dt);

  const V = (v) => [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)];

  /* --- o jogador vira boneco imortal durante a medicao ---
   *
   * ARMADILHA JA PAGA: sem isto a medicao se envenena sozinha. As celulas
   * rodam em sequencia; assim que o hostil comeca a acertar, o jogador morre
   * numa delas e TODAS as seguintes medem um alvo morto — `Perception` ignora
   * alvo com `alive === false`, entao o laudo mostra "NUNCA notou" a 20 e 30 m
   * e a culpa parece ser da percepcao. Zerar a vida entre celulas nao basta:
   * ele morre DENTRO da celula. O dano e contabilizado em vez de aplicado. */
  let danoCelula = 0;
  jog.takeDamage = function (d) { danoCelula += d; return this.health; };

  /**
   * Procura um posto a `dist` metros do jogador com chao, celula andavel e
   * visada livre olho-a-olho. Devolve tambem quanto o resultado desviou do
   * pedido, para o laudo poder desconfiar do proprio instrumento.
   */
  function acharPosto(dist) {
    const pj = jog.position;
    const olhoJ = jog.eyePosition;
    const yaw0 = jog.rig?.yaw ?? 0;
    const grid = ctx.world.navGrid;
    const cs = grid?.cellSize ?? 0.5;
    const ox = grid?.origin?.x ?? 0;
    const oz = grid?.origin?.z ?? 0;
    // ATENCAO: isWalkable recebe INDICE DE CELULA, nao metros.
    const cel = (v, o) => Math.floor((v - o) / cs);

    let melhor = null;
    for (const dr of [0, 0.6, -0.6, 1.2, -1.2]) {
      const raio = dist + dr;
      for (let k = 0; k < 60; k++) {
        // varre em leque a partir da frente do jogador, abrindo para os lados
        const passo = Math.ceil(k / 2) * 6 * (k % 2 ? 1 : -1);
        const ang = yaw0 + Math.PI + passo * Math.PI / 180;
        const x = pj.x - Math.sin(ang) * raio;
        const z = pj.z - Math.cos(ang) * raio;
        if (grid?.isWalkable && !grid.isWalkable(cel(x, ox), cel(z, oz))) continue;
        const y = col.groundAt(x, z, 200);
        if (!Number.isFinite(y) || Math.abs(y - pj.y) > 6) continue;
        // visada olho-a-olho livre?
        const ox2 = x, oy2 = y + OLHO_HOSTIL, oz2 = z;
        const dx = olhoJ.x - ox2, dy = olhoJ.y - oy2, dz = olhoJ.z - oz2;
        const d3 = Math.hypot(dx, dy, dz);
        const hit = col.raycast(
          { x: ox2, y: oy2, z: oz2 },
          { x: dx / d3, y: dy / d3, z: dz / d3 },
          d3 - 0.25,
        );
        // `raycast` devolve SEMPRE o mesmo objeto: le agora, nao guarda.
        if (hit && hit.hit) continue;
        melhor = { x, y, z, dist3: d3, desvio: Math.abs(d3 - dist) };
        break;
      }
      if (melhor) break;
    }
    return melhor;
  }

  /**
   * Uma medicao. `postura` = 'parado' (sem rota) ou 'ronda' (rota do jogo).
   * `angGraus` = rumo do hostil em relacao a direcao do jogador.
   */
  function medir(dist, angGraus, postura) {
    ai.reset();
    const posto = acharPosto(dist);
    if (!posto) return { dist, ang: angGraus, erro: 'sem posto com visada' };

    const pj = jog.position;
    // convencao do hostil: frente = (sin yaw, cos yaw)
    const yawParaJogador = Math.atan2(pj.x - posto.x, pj.z - posto.z);
    const yaw = yawParaJogador + angGraus * Math.PI / 180;
    const e = ai.spawn({ x: posto.x, y: posto.y, z: posto.z },
      yaw, postura === 'ronda' ? null : []);
    if (!e) return { dist, ang: angGraus, erro: 'spawn falhou' };

    if (postura === 'parado') {
      // sentinela sem rota: fica no posto. E o pior caso da percepcao.
      e.patrulha.length = 0;
      e.caminho.length = 0;
      e.temDestino = false;
      e._trocar('ocioso');
    }

    const erroPosto = Math.hypot(e.pos.x - posto.x, e.pos.y - posto.y, e.pos.z - posto.z);
    const angInicial = e.percepcao ? angGraus : angGraus;

    danoCelula = 0;
    let tNotou = null, tAlerta = null, tAtirou = null, tiros = 0;
    let tt = 0;
    const estados = [];
    const off = ctx.bus.on('enemy:fire', (ev) => {
      if (ev.enemyId !== e.id) return;
      if (tAtirou === null) tAtirou = tt;
      tiros++;
    });

    const n = Math.round(60 * DURACAO);
    for (let i = 0; i < n; i++) {
      jog.update(dt);          // mantem o olho do jogador REAL (a correcao)
      ai.update(dt);
      tt += dt;
      const c = e.percepcao?.consciencia ?? 0;
      if (tNotou === null && c > 0.35) tNotou = tt;
      if (tAlerta === null && c >= 1.0) tAlerta = tt;
      if (estados[estados.length - 1] !== e.estado) estados.push(e.estado);
      if (tAtirou !== null && tt > tAtirou + 0.4) break;
    }
    off?.();

    const pc = e.percepcao;
    return {
      dist, ang: angGraus, postura,
      distReal: +posto.dist3.toFixed(1),
      erroPosto: +erroPosto.toFixed(2),
      distFim: +e.pos.distanceTo(jog.position).toFixed(1),
      tNotou: tNotou === null ? null : +tNotou.toFixed(1),
      tAlerta: tAlerta === null ? null : +tAlerta.toFixed(1),
      tAtirou: tAtirou === null ? null : +tAtirou.toFixed(1),
      tiros,
      dano: Math.round(danoCelula),
      vivo: jog.alive,
      cons: +(pc?.consciencia ?? 0).toFixed(2),
      viu: !!pc?.viuAlgumaVez,
      estados: estados.join('>'),
      angFim: +((pc?.anguloAlvo ?? 0) * 180 / Math.PI).toFixed(0),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Aferição do instrumento                                             */
  /* ------------------------------------------------------------------ */
  const olho = jog.eyePosition;
  const aferi = {
    estado: ctx.state,
    pos: V(jog.position),
    olho: V(olho),
    alturaOlho: +(olho.y - jog.position.y).toFixed(2),
    olhoNaOrigem: olho.lengthSq() < 1e-6,
    spawnAuto: ai.spawnAutomatico,
    fase: ctx.progressao?.fase ?? null,
    perfil: perfil ? {
      reacao: perfil.reacao.map((x) => +x.toFixed(2)),
      erro0: +perfil.erro0.toFixed(3), erroMin: +perfil.erroMin.toFixed(3),
      dano: +perfil.dano.toFixed(1),
    } : null,
  };

  /* ------------------------------------------------------------------ */
  const tabelaA = [];
  for (const d of [6, 12, 20, 30]) {
    for (const a of [0, 90, 180]) tabelaA.push(medir(d, a, 'parado'));
  }
  const tabelaB = [];
  for (const d of [6, 12, 20, 30]) tabelaB.push(medir(d, 90, 'ronda'));

  /* ------------------------------------------------------------------ */
  /* C) passeio: o jogador ANDA de verdade, em circulo, com passo audivel */
  /* ------------------------------------------------------------------ */
  function passeio(dist, angGraus) {
    ai.reset();
    const posto = acharPosto(dist);
    if (!posto) return { dist, erro: 'sem posto' };
    const pj0 = jog.position.clone();
    const yawParaJogador = Math.atan2(pj0.x - posto.x, pj0.z - posto.z);
    const e = ai.spawn({ x: posto.x, y: posto.y, z: posto.z },
      yawParaJogador + angGraus * Math.PI / 180, []);
    if (!e) return { dist, erro: 'spawn falhou' };
    e.patrulha.length = 0; e.caminho.length = 0; e.temDestino = false;
    e._trocar('ocioso');

    const inp = ctx.input;
    const lockAntes = inp.locked;
    inp.locked = true;               // finge pointer lock: o Player le o teclado
    inp.keys.add('KeyW');
    // giro constante para o passeio virar circulo em vez de linha reta
    const sens = ctx.settings?.sensitivity ?? 0.0022;
    const giroPorQuadro = (3.0 / 7.0) * dt;      // v/r rad por quadro
    danoCelula = 0;
    let tt = 0, tNotou = null, tAtirou = null, passos = 0, andou = 0;
    const offPasso = ctx.bus.on('player:footstep', () => passos++);
    const off = ctx.bus.on('enemy:fire', (ev) => {
      if (ev.enemyId === e.id && tAtirou === null) tAtirou = tt;
    });
    let ant = jog.position.clone();
    const n = Math.round(60 * DURACAO);
    for (let i = 0; i < n; i++) {
      inp.mouseDX = giroPorQuadro / sens;
      inp.mouseDY = 0;
      jog.update(dt);
      inp.mouseDX = 0;
      ai.update(dt);
      andou += Math.hypot(jog.position.x - ant.x, jog.position.z - ant.z);
      ant.copy(jog.position);
      tt += dt;
      const c = e.percepcao?.consciencia ?? 0;
      if (tNotou === null && c > 0.35) tNotou = tt;
      if (tAtirou !== null && tt > tAtirou + 0.4) break;
    }
    off?.(); offPasso?.();
    inp.keys.delete('KeyW');
    inp.locked = lockAntes;
    inp.mouseDX = 0;
    return {
      dist, ang: angGraus,
      tNotou: tNotou === null ? null : +tNotou.toFixed(1),
      tAtirou: tAtirou === null ? null : +tAtirou.toFixed(1),
      passos, andou: +andou.toFixed(1), dano: Math.round(danoCelula),
      distFim: +e.pos.distanceTo(jog.position).toFixed(1),
      estado: e.estado,
    };
  }
  const tabelaC = [];
  for (const a of [0, 180]) tabelaC.push(passeio(12, a));

  // higiene: devolve o dano de verdade ao jogador e limpa o campo
  delete jog.takeDamage;
  ai.reset();
  return { aferi, tabelaA, tabelaB, tabelaC };
}, { ONDA, DURACAO });

/* ---------------------------------------------------------------------- */
const P = (x, n = 6) => String(x ?? 'NUNCA').padEnd(n);
const a = r.aferi;
console.log('');
console.log('AFERICAO DO INSTRUMENTO');
console.log('  estado=' + a.estado + '  ondas automaticas=' + (a.spawnAuto ? 'LIGADAS (ruim)' : 'desligadas')
  + '  progressao=' + a.fase);
console.log('  jogador pe=' + JSON.stringify(a.pos) + '  olho=' + JSON.stringify(a.olho)
  + '  altura do olho=' + a.alturaOlho + ' m'
  + (a.olhoNaOrigem ? '   <<< OLHO NA ORIGEM: MEDICAO INVALIDA' : ''));
if (a.perfil) {
  console.log('  perfil (onda ' + ONDA + '): reacao ' + a.perfil.reacao.join('-') + ' s'
    + '  erro0 ' + a.perfil.erro0 + '  erroMin ' + a.perfil.erroMin + '  dano ' + a.perfil.dano);
}
const desvio = Math.max(...r.tabelaA.filter((x) => !x.erro).map((x) => x.erroPosto));
console.log('  posto pedido vs. real: desvio maximo ' + desvio.toFixed(2) + ' m'
  + '   cenarios sem visada: ' + r.tabelaA.filter((x) => x.erro).length + '/' + r.tabelaA.length);

console.log('');
console.log('A) SENTINELA PARADA — hostil sem rota, jogador parado e em silencio (' + DURACAO + ' s)');
console.log('     dist |  de frente (0)   |  de lado (90)    |  de costas (180)');
console.log('          | notou  atirou    | notou  atirou    | notou  atirou');
for (const d of [6, 12, 20, 30]) {
  const linha = [0, 90, 180].map((ang) => {
    const c = r.tabelaA.find((x) => x.dist === d && x.ang === ang);
    if (!c) return '  ?               ';
    if (c.erro) return ' ' + P(c.erro, 17);
    return ' ' + P(c.tNotou, 6) + ' ' + P(c.tAtirou, 10);
  });
  console.log('   ' + String(d).padStart(3) + ' m  |' + linha.join('|'));
}

console.log('');
console.log('B) RONDA NATURAL — hostil com a rota que o jogo monta, rumo inicial 90 graus');
for (const c of r.tabelaB) {
  if (c.erro) { console.log('   ' + String(c.dist).padStart(3) + ' m  ' + c.erro); continue; }
  console.log('   ' + String(c.dist).padStart(3) + ' m  notou=' + P(c.tNotou) + ' atirou=' + P(c.tAtirou)
    + ' dano=' + String(c.dano).padStart(3) + ' dist no fim=' + String(c.distFim).padStart(5) + ' m  estados: ' + c.estados);
}

console.log('');
console.log('C) PASSEIO — jogador andando em circulo a 12 m (o relato original)');
for (const c of r.tabelaC) {
  if (c.erro) { console.log('   ' + c.erro); continue; }
  console.log('   rumo ' + String(c.ang).padStart(3) + ' graus  notou=' + P(c.tNotou) + ' atirou=' + P(c.tAtirou)
    + '  passos=' + String(c.passos).padStart(3) + '  andou=' + String(c.andou).padStart(5) + ' m'
    + '  dano=' + c.dano + '  dist no fim=' + c.distFim + ' m  estado=' + c.estado);
}

console.log('');
console.log('detalhe da tabela A (consciencia final, angulo final, estados):');
for (const c of r.tabelaA) {
  if (c.erro) continue;
  console.log('   ' + String(c.dist).padStart(2) + ' m / ' + String(c.ang).padStart(3) + ' graus'
    + '  d3=' + c.distReal + '  cons=' + String(c.cons).padEnd(5)
    + ' viu=' + (c.viu ? 'sim' : 'nao') + ' angFim=' + String(c.angFim).padStart(3)
    + '  ' + c.estados);
}

await browser.close();
vite.kill();
