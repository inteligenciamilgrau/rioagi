/**
 * drone.mjs — o drone é justo de acertar?
 *
 * Mede as três coisas que decidem isso, com o jogo de verdade rodando:
 *
 *   A) SANIDADE      o bicho voa? fica na faixa de altitude? trava em beco?
 *   B) TTK           quanto tempo e quantos tiros um jogador razoável gasta
 *                    para derrubar UM drone, e quanto ele erra tentando.
 *   C) CICLO         o drone de fato PARA antes de atirar? por quanto tempo?
 *                    quantos pairam/atiram ao mesmo tempo (teto de justiça)?
 *
 * O jogador sintético do item B não é um robô perfeito — se fosse, mediria a
 * hitbox e não a experiência. Ele tem:
 *   - tempo de reação antes de começar a mirar;
 *   - velocidade ANGULAR MÁXIMA de mira (um humano não gira instantâneo);
 *   - erro de mira que converge enquanto ele segue o alvo, e que volta a subir
 *     quando o alvo muda de direção de repente;
 *   - a cadência, o espalhamento e a queda de dano REAIS da IA2.
 * O acerto é resolvido pelo mesmo `ai.raycastEnemies` que a arma do jogo usa,
 * então o que sai daqui é a hitbox de verdade, não uma aproximação.
 *
 * ARMADILHA JÁ PAGA (ver NOTES [AI] seção 0): `Perception` mira em
 * `ctx.player.eyePosition`, escrito só dentro de `Player.update()`. Um laço que
 * roda apenas `ai.update()` faz o hostil enxergar um fantasma em (0,0,0). Aqui
 * o `player.update` roda em TODAS as células, e o instrumento se afere sozinho.
 *
 * Uso: node tools/drone.mjs
 *      TENT=16 node tools/drone.mjs
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 5281);
const TENT = Number(process.env.TENT ?? 14);

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
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERR:', String(e).split('\n')[0]));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text().split('\n')[0].slice(0, 200)); });
await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready, undefined, { timeout: 240000 });
await page.waitForTimeout(1500);

const r = await page.evaluate(async ({ TENT }) => {
  const ctx = window.__game.ctx;
  const jog = ctx.player;
  const ai = ctx.ai;
  const col = ctx.world.collision;
  const V = ctx.camera.position.constructor;
  const dt = 1 / 60;

  ctx.state = 'jogando';
  ai.spawnAutomatico = false;
  ai.reset();

  /* --- aferição do instrumento (NOTES [AI] seção 0) ------------------- */
  jog.update(dt);
  const olho = jog.eyePosition;
  const afericao = {
    pe: [+jog.position.x.toFixed(2), +jog.position.y.toFixed(2), +jog.position.z.toFixed(2)],
    olho: [+olho.x.toFixed(2), +olho.y.toFixed(2), +olho.z.toFixed(2)],
    alturaOlho: +(olho.y - jog.position.y).toFixed(2),
    olhoNaOrigem: Math.abs(olho.x) < 0.01 && Math.abs(olho.y) < 0.01 && Math.abs(olho.z) < 0.01,
  };

  const rec = ai.poolDrone[0];
  const geo = {
    trisCorpo: rec.corpo.geometry.index.count / 3,
    vertsCorpo: rec.corpo.geometry.attributes.position.count,
    poolDrone: ai.poolDrone.length,
    poolSolo: ai.poolSolo.length,
  };

  /* ================================================================== *
   * A) SANIDADE — voo livre, sem combate                                *
   * ================================================================== */
  const sanidade = (() => {
    ai.reset();
    const feitos = ai.spawnOnda(6, 20, 55, 'drone');
    const alts = [];
    const folgas = [];
    let minAlt = 9e9, maxAlt = -9e9;
    let travados = 0, abaixoDoChao = 0, encostou = 0, penetrou = 0;
    const anterior = new Map();
    const parado = new Map();
    const alvoBVH = { point: new V(), faceIndex: 0, distance: 0 };

    for (let i = 0; i < 60 * 30; i++) {
      jog.update(dt);
      ai.update(dt);
      if (i % 12 !== 0) continue;
      for (const d of ai.getEnemies()) {
        if (!d.eDrone) continue;
        /* ALTURA: usa a MESMA sonda do drone (`_chaoY`, raio de pouco acima
         * dele para baixo) e nao `col.groundAt`, que desce de y=200.
         *
         * Medido com groundAt na primeira versao desta ferramenta: altura
         * "minima" de -5,98 m e "maxima" de 10,08 m, o que sugeria drone
         * enterrado no chao e drone na fiacao. Nao era nem um nem outro: o raio
         * de y=200 acerta o TELHADO que esta em cima do drone quando ele passa
         * sob um beiral ou dentro de um vao coberto, e ai a conta da altura
         * negativa. E exatamente a armadilha que o cabecalho do Drone.js
         * descreve — e ela pegou primeiro a propria ferramenta. */
        const alt = d.pos.y - d._chaoY;
        if (Number.isFinite(alt)) {
          alts.push(alt);
          if (alt < minAlt) minAlt = alt;
          if (alt > maxAlt) maxAlt = alt;
          if (alt < 0.9) abaixoDoChao++;
        }
        /* FOLGA ate a geometria mais proxima. Numero, nao sim/nao: "encostou"
         * a 0,30 m nao diz se o drone raspou a quina ou se meio corpo estava
         * dentro do muro. O corpo real tem ~0,30 m de meia-largura no chassi e
         * 0,42 m de envelope contando os bracos. */
        const achou = col.bvh?.closestPointToPoint(d.pos, alvoBVH, 0, 0.9);
        const folga = achou ? d.pos.distanceTo(alvoBVH.point) : 0.9;
        folgas.push(folga);
        if (folga < 0.42) encostou++;
        if (folga < 0.16) penetrou++;
        // travado: quer andar e não anda
        const ant = anterior.get(d.id);
        if (ant) {
          const andou = d.pos.distanceTo(ant);
          const p = (parado.get(d.id) ?? 0) + (andou < 0.25 ? 1 : 0);
          parado.set(d.id, andou < 0.25 ? p : 0);
          if (p === 12) travados++;      // 12 amostras de 0,2 s = 2,4 s parado
        }
        anterior.set(d.id, d.pos.clone());
      }
    }
    alts.sort((a, b) => a - b);
    folgas.sort((a, b) => a - b);
    const q = (a, f) => (a.length ? +a[Math.min(a.length - 1, Math.floor(a.length * f))].toFixed(2) : 0);
    return {
      nasceram: feitos,
      amostras: alts.length,
      altMin: +minAlt.toFixed(2), altP05: q(alts, 0.05), altMed: q(alts, 0.5),
      altP95: q(alts, 0.95), altMax: +maxAlt.toFixed(2),
      folgaMin: q(folgas, 0), folgaP05: q(folgas, 0.05), folgaMed: q(folgas, 0.5),
      abaixoDoChao, encostou, penetrou, travados,
      vivosNoFim: ai.getEnemies().filter((e) => e.eDrone).length,
    };
  })();

  /* ================================================================== *
   * B) TTK — jogador sintético com mira humana                          *
   * ================================================================== */
  const W = ctx.player.weaponSystem?.slotDe?.('ia2')
    ?? { damage: 33, rpm: 700, spreadADS: 0.10, range: 200 };
  const arma = { damage: 33, rpm: 700, spreadADS: 0.10 };
  const INTERVALO = 60 / arma.rpm;
  const REACAO = 0.35;          // s até começar a mirar
  const SLEW = 3.6;             // rad/s — teto de giro da mira
  const ERRO0 = 0.075;          // rad de erro ao adquirir
  const ERRO_MIN = 0.006;       // rad com o alvo já seguido
  const CONVERGE = 2.6;         // 1/s

  const falloff = (d) => (d <= 26 ? 1 : d <= 48 ? 1 - (d - 26) / 22 * 0.22 : 0.78);

  const tentativas = [];
  for (let t = 0; t < TENT && tentativas.length < TENT; t++) {
    ai.reset();
    // um drone só, nascido na faixa em que a onda o entrega
    const feitos = ai.spawnOnda(1, 22, 38, 'drone');
    if (!feitos) continue;
    const alvo = ai.getEnemies().find((e) => e.eDrone);
    if (!alvo) continue;
    /* Consciência CHEIA, e não 0,6.
     *
     * Com 0,6 ele entra em SUSPEITO, investiga, não acha ninguém (o boneco fica
     * parado e em silêncio, então não há passo para ouvir) e volta a patrulhar
     * — duas de seis tentativas terminaram com ZERO tiros disparados porque o
     * drone nunca chegou a aparecer. Isso é um dado sobre RITMO, não sobre TTK,
     * e misturar os dois estraga as duas medidas. Aqui queremos medir o custo
     * de derrubar um drone que JÁ está vindo em cima, que é a situação que a
     * `Progressao` produz (ela chama `convergirNoJogador` a cada leva). */
    alvo.percepcao.avisar(jog.position, 1.2);

    const mira = new V(0, 0, -1);
    const dirIdeal = new V();
    let erro = ERRO0;
    let tVisivel = -1, tMorte = -1;
    let tiros = 0, acertos = 0, acertosNucleo = 0;
    let tProxTiro = 0, tempo = 0;
    let mirando = 0;
    let janelas = 0, tJanela = 0, estadoAnt = '';
    const dists = [];
    let danoTomado = 0;
    const takeOrig = jog.takeDamage.bind(jog);
    jog.takeDamage = function (d, dir, src) { danoTomado += d; return jog.health; };

    // mira inicial: para onde o jogador estava olhando
    ctx.camera.getWorldDirection(mira);

    for (let i = 0; i < 60 * 25; i++) {
      jog.update(dt);
      ai.update(dt);
      tempo += dt;
      if (!alvo.alive) { tMorte = tempo; break; }

      // ciclo do drone
      if (alvo.estado !== estadoAnt) {
        if (alvo.estado === 'pairar') { janelas++; tJanela = 0; }
        estadoAnt = alvo.estado;
      }
      if (alvo.estado === 'pairar' || alvo.estado === 'atirar') tJanela += dt;

      // o jogador só vê o drone com linha de visada livre
      const de = jog.eyePosition;
      dirIdeal.copy(alvo.pos).sub(de);
      const dist = dirIdeal.length();
      dirIdeal.divideScalar(dist);
      const h = col.raycast(de, dirIdeal, dist - 0.5);
      const vis = !(h && h.hit) && dist < 60;
      if (!vis) { mirando = 0; erro = ERRO0; continue; }
      if (tVisivel < 0) tVisivel = tempo;
      mirando += dt;
      dists.push(dist);
      if (mirando < REACAO) continue;

      /* --- giro da mira, limitado em velocidade angular --- */
      const ang = Math.acos(Math.max(-1, Math.min(1, mira.dot(dirIdeal))));
      const passo = Math.min(ang, SLEW * dt);
      if (ang > 1e-4) {
        // slerp manual: gira `passo` rad na direção do alvo
        const k = passo / ang;
        mira.lerp(dirIdeal, k).normalize();
      }
      // o erro cai enquanto segue, mas o resíduo de giro o mantém alto
      erro += (ERRO_MIN - erro) * Math.min(1, dt * CONVERGE);
      erro = Math.max(erro, Math.min(ERRO0, ang * 0.55));

      /* --- tiro --- */
      tProxTiro -= dt;
      if (tProxTiro > 0) continue;
      tProxTiro = INTERVALO;
      tiros++;
      const e = erro + arma.spreadADS * Math.PI / 180 * 0.5;
      const d2 = new V(
        mira.x + (Math.random() * 2 - 1) * e,
        mira.y + (Math.random() * 2 - 1) * e,
        mira.z + (Math.random() * 2 - 1) * e,
      ).normalize();
      const er = ai.raycastEnemies(de, d2, 200);
      const wr = col.raycast(de, d2, er ? er.distance : 200);
      if (er && (!wr || !wr.hit || wr.distance > er.distance)) {
        acertos++;
        if (er.part === 'nucleo') acertosNucleo++;
        const dmg = arma.damage * falloff(er.distance);
        ai.damageEnemy(er.enemyId, dmg, { point: er.point, part: er.part, weapon: 'ia2' });
      }
    }
    jog.takeDamage = takeOrig;
    if (tMorte < 0) {
      /* Falha tem de dizer POR QUE. "Não morreu" pode ser hitbox ruim, voo
       * travado ou o drone simplesmente nunca ter chegado — três defeitos
       * diferentes, com três correções diferentes. */
      tentativas.push({
        falhou: true, tiros, acertos,
        estado: alvo.estado, vida: Math.round(alvo.vida),
        dist: +alvo.pos.distanceTo(jog.position).toFixed(1),
        alt: +(alvo.pos.y - alvo._chaoY).toFixed(1),
        viu: tVisivel >= 0,
        consc: +alvo.percepcao.consciencia.toFixed(2),
      });
      continue;
    }
    dists.sort((a, b) => a - b);
    tentativas.push({
      t: +(tMorte - tVisivel).toFixed(2),
      tiros, acertos,
      pct: Math.round(100 * acertos / Math.max(1, tiros)),
      nucleo: acertosNucleo,
      distMed: dists.length ? +dists[dists.length >> 1].toFixed(1) : 0,
      janelas, dano: Math.round(danoTomado),
    });
  }

  /* ================================================================== *
   * C) CICLO E TETO DE FOGO — enxame de verdade                         *
   * ================================================================== */
  const ciclo = await (async () => {
    ai.reset();
    ai.maxVivos = 10; ai.maxDrones = 10; ai.maxAtiradores = 3;
    ai.spawnOnda(10, 20, 50, 'drone');
    for (const d of ai.getEnemies()) d.percepcao.avisar(jog.position, 0.7);

    const durPairar = [];
    let picoAtirando = 0, quadros = 0, quadrosComExcesso = 0;
    let danoTomado = 0, tirosDrone = 0;
    const inicioPairar = new Map();
    const takeOrig = jog.takeDamage.bind(jog);
    jog.takeDamage = function (d) { danoTomado += d; return jog.health; };
    const off = ctx.bus.on('enemy:fire', () => tirosDrone++);
    const estAnt = new Map();
    const censo = [];

    for (let i = 0; i < 60 * 90; i++) {
      jog.update(dt);
      /* O boneco ATIRA a cada 2 s. Não é enfeite: um jogador dentro de um
       * enxame está atirando, e `weapon:fire` é o que a IA escuta (raio de
       * 70 m no fuzil). Um dummy absolutamente silencioso e imóvel mede um
       * caso que não existe em jogo — e foi ele que produziu o falso "os
       * drones nunca engajam" numa passagem anterior desta ferramenta. */
      if (i % 120 === 0) {
        ctx.bus.emit('weapon:fire', {
          weapon: 'ia2', origin: jog.eyePosition.clone(),
          dir: new V(0, 0, -1), spread: 0,
        });
      }
      ai.update(dt);
      quadros++;
      let atirando = 0;
      for (const d of ai.getEnemies()) {
        if (!d.eDrone) continue;
        if (d.ocupaVagaDeFogo) atirando++;
        const ant = estAnt.get(d.id);
        if (ant !== d.estado) {
          if (d.estado === 'pairar') inicioPairar.set(d.id, i);
          if (ant === 'pairar' && inicioPairar.has(d.id)) {
            durPairar.push((i - inicioPairar.get(d.id)) / 60);
          }
          estAnt.set(d.id, d.estado);
        }
      }
      if (atirando > picoAtirando) picoAtirando = atirando;
      if (atirando > ai.maxAtiradores) quadrosComExcesso++;
      if (i % (60 * 15) === 0) {
        const est = {};
        for (const d of ai.getEnemies()) est[d.estado] = (est[d.estado] ?? 0) + 1;
        censo.push({ t: Math.round(i / 60), vivos: ai.getEnemies().length, est });
      }
    }
    jog.takeDamage = takeOrig;
    off?.();
    durPairar.sort((a, b) => a - b);
    return {
      janelas: durPairar.length,
      pairarMin: durPairar.length ? +durPairar[0].toFixed(2) : 0,
      pairarMed: durPairar.length ? +durPairar[durPairar.length >> 1].toFixed(2) : 0,
      pairarMax: durPairar.length ? +durPairar[durPairar.length - 1].toFixed(2) : 0,
      picoAtirando, tetoPedido: ai.maxAtiradores,
      quadrosComExcesso, quadros,
      danoPorMin: Math.round(danoTomado / 1.5),
      tirosDrone,
      censo,
    };
  })();

  return { afericao, geo, sanidade, tentativas, ciclo };
}, { TENT });

/* --------------------------------------------------------------------- */

const p = (x, n = 6) => String(x).padStart(n);

console.log('');
console.log('AFERICAO DO INSTRUMENTO');
console.log('  pe   ' + JSON.stringify(r.afericao.pe));
console.log('  olho ' + JSON.stringify(r.afericao.olho) + '   altura do olho ' + r.afericao.alturaOlho + ' m');
if (r.afericao.olhoNaOrigem) console.log('  *** OLHO NA ORIGEM: MEDICAO INVALIDA ***');

console.log('');
console.log('MALHA   corpo ' + r.geo.trisCorpo + ' tris / ' + r.geo.vertsCorpo + ' verts'
  + '   ·   pool: ' + r.geo.poolDrone + ' drones + ' + r.geo.poolSolo + ' de chao');

console.log('');
console.log('A) SANIDADE DE VOO — 6 drones, 30 s, sem combate');
const s = r.sanidade;
console.log('  nasceram ' + s.nasceram + ', vivos no fim ' + s.vivosNoFim + '  (' + s.amostras + ' amostras)');
console.log('  altura sobre o chao (sonda do proprio drone):');
console.log('    min ' + s.altMin + '  p05 ' + s.altP05 + '  mediana ' + s.altMed
  + '  p95 ' + s.altP95 + '  max ' + s.altMax + ' m   (faixa pedida 2,4-4,4, teto 5,4)');
console.log('  folga ate a geometria mais proxima:');
console.log('    min ' + s.folgaMin + '  p05 ' + s.folgaP05 + '  mediana ' + s.folgaMed + ' m');
console.log('  amostras abaixo de 0,9 m do chao: ' + s.abaixoDoChao);
console.log('  amostras raspando (< 0,42 m de folga): ' + s.encostou
  + '   ·   penetrando (< 0,16 m): ' + s.penetrou + '  de ' + s.amostras);
console.log('  episodios de travamento (2,4 s sem sair do lugar): ' + s.travados);

console.log('');
console.log('B) TTK — quanto custa derrubar UM drone');
console.log('  tent |  t(s) | tiros | acertos |   % | nucleo | dist | janelas | dano tomado');
const ok = r.tentativas.filter((t) => !t.falhou);
r.tentativas.forEach((t, i) => {
  if (t.falhou) {
    console.log('  ' + p(i + 1, 4) + ' |  NAO MORREU em 25 s — ' + t.tiros + ' tiros, ' + t.acertos + ' acertos'
      + ' | estado=' + t.estado + ' vida=' + t.vida + ' dist=' + t.dist + 'm alt=' + t.alt + 'm'
      + ' consc=' + t.consc + (t.viu ? ' (chegou a ser visto)' : ' (NUNCA visto)'));
    return;
  }
  console.log('  ' + p(i + 1, 4) + ' | ' + p(t.t.toFixed(2), 5) + ' | ' + p(t.tiros, 5) + ' | '
    + p(t.acertos, 7) + ' | ' + p(t.pct, 3) + ' | ' + p(t.nucleo, 6) + ' | ' + p(t.distMed, 4)
    + ' | ' + p(t.janelas, 7) + ' | ' + p(t.dano, 11));
});
if (ok.length) {
  const med = (k) => { const a = ok.map((x) => x[k]).sort((x, y) => x - y); return a[a.length >> 1]; };
  const soma = (k) => ok.reduce((a, x) => a + x[k], 0);
  console.log('  ------------------------------------------------------------------------');
  console.log('  MEDIANA: ' + med('t').toFixed(2) + ' s  ·  ' + med('tiros') + ' tiros disparados  ·  '
    + med('acertos') + ' acertos  ·  ' + Math.round(100 * soma('acertos') / soma('tiros')) + '% de acerto'
    + '  ·  distancia mediana ' + med('distMed') + ' m');
  console.log('  falhas (nao morreu em 25 s): ' + (r.tentativas.length - ok.length) + ' de ' + r.tentativas.length);
}

console.log('');
console.log('C) CICLO E TETO DE FOGO — 10 drones, 90 s');
const c = r.ciclo;
console.log('  janelas de tiro (PAIRAR) observadas: ' + c.janelas);
console.log('  duracao da janela: min ' + c.pairarMin + '  mediana ' + c.pairarMed + '  max ' + c.pairarMax + ' s');
console.log('  pico de drones ocupando vaga de fogo: ' + c.picoAtirando + '  (teto pedido: ' + c.tetoPedido + ')');
console.log('  quadros acima do teto: ' + c.quadrosComExcesso + ' de ' + c.quadros
  + (c.quadrosComExcesso === 0 ? '   <- teto respeitado' : '   <- TETO FURADO'));
console.log('  tiros de drone em 90 s: ' + c.tirosDrone + '   ·   dano por minuto no boneco parado: ' + c.danoPorMin);
console.log('  censo:');
for (const x of c.censo) console.log('    t=' + p(x.t, 3) + 's  vivos=' + x.vivos + '  ' + JSON.stringify(x.est));

await browser.close();
vite.kill();
