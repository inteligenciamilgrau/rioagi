/**
 * audioenxame.mjs — o áudio picota com o enxame? Medido DENTRO do jogo.
 *
 * Por que não bastou o `tools/enxame.mjs`: lá o boneco ficava parado e em
 * silêncio, e o enxame passava metade do tempo procurando. Deu 0% de descarte e
 * a conclusão foi "cabe folgado" — e o jogador relatou picote na mesma versão.
 * A medição estava certa sobre a cena que ela montou e errada sobre o jogo.
 *
 * Aqui a cena é a de verdade:
 *   - onda temática de drone em campo, drones engajados;
 *   - o JOGADOR ATIRANDO a 700 rpm, que é o que ele faz num enxame. A arma dele
 *     sozinha pede ~35 vozes por segundo (tiro + impacto + cartucho) e é a
 *     maior fonte da mixagem;
 *   - impactos e mortes acontecendo de verdade.
 *
 * Além de pedidos/negados, conta CHAMADAS POR EVENTO: quantos `tiro()` saem por
 * `enemy:fire`. Se sair mais de um, há som duplicado — e som duplicado não
 * aparece como "descarte alto", aparece como o dobro do custo de síntese pelo
 * mesmo evento.
 *
 * ARMADILHAS DE MEDIÇÃO respeitadas aqui:
 *   - NADA de `--autoplay-policy=no-user-gesture-required`: o contexto é
 *     destravado por um clique de verdade, como em jogo.
 *   - Nada de OfflineAudioContext: a bancada offline subestima o custo real em
 *     ~6x. Isto roda no jogo, com render 3D, física e IA disputando a máquina.
 *   - A deriva entre relógio de parede e relógio de áudio é o número honesto;
 *     o contador de "travadas" a 8 ms de amostragem tem ruído próprio.
 *
 * Uso: node tools/audioenxame.mjs [rotulo]
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const ROTULO = process.argv[2] || 'medicao';
const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 5289);
const DUR = Number(process.env.DUR ?? 12);

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
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--js-flags=--expose-gc'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERR:', String(e).split('\n')[0]));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text().split('\n')[0].slice(0, 180)); });
await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready, undefined, { timeout: 240000 });
// gesto de verdade: é assim que o AudioContext destrava em jogo
await page.mouse.click(640, 360);
await page.waitForTimeout(1200);

const estado = await page.evaluate(() => ({
  audio: window.__game.ctx.audio?.actx?.state ?? 'sem-contexto',
}));
if (estado.audio !== 'running') {
  console.log('AVISO: AudioContext em "' + estado.audio + '" — a medicao nao vale.');
}

const r = await page.evaluate(async ({ DUR }) => {
  const ctx = window.__game.ctx, A = ctx.audio, ai = ctx.ai, prog = ctx.progressao;
  const esperar = (s) => new Promise((res) => setTimeout(res, s * 1000));
  const V = ctx.camera.position.constructor;

  /* --- instrumentacao de nos WebAudio (igual ao audiodiag) ------------- */
  const criados = {};
  let nCriados = 0;
  const proto = Object.getPrototypeOf(A.actx);
  const METODOS = ['createGain', 'createBiquadFilter', 'createPanner', 'createBufferSource',
    'createOscillator', 'createConvolver', 'createDelay', 'createWaveShaper',
    'createStereoPanner', 'createDynamicsCompressor'];
  for (const m of METODOS) {
    const orig = proto[m];
    if (!orig) continue;
    proto[m] = function (...a) {
      criados[m] = (criados[m] || 0) + 1; nCriados++;
      return orig.apply(this, a);
    };
  }

  /* --- pedidos de voz, por prioridade --------------------------------- */
  let pedidos = 0, negados = 0;
  const porPrio = {};
  const _vozOrig = A._voz.bind(A);
  A._voz = (pos, o = {}) => {
    pedidos++;
    const k = String(o.prio ?? 0);
    porPrio[k] = porPrio[k] || { pediu: 0, negou: 0 };
    porPrio[k].pediu++;
    const res = _vozOrig(pos, o);
    if (!res) { negados++; porPrio[k].negou++; }
    return res;
  };

  /* --- chamadas por evento: pega som DUPLICADO ------------------------- */
  const chamadas = { tiro: 0, impacto: 0, grito: 0, droneInvestida: 0, droneQueda: 0, passo: 0 };
  for (const nome of Object.keys(chamadas)) {
    if (typeof A[nome] !== 'function') continue;
    const orig = A[nome].bind(A);
    A[nome] = (...a) => { chamadas[nome]++; return orig(...a); };
  }
  const eventos = { 'enemy:fire': 0, 'weapon:fire': 0, 'weapon:hit': 0, 'enemy:killed': 0, 'enemy:damaged': 0 };
  const offs = Object.keys(eventos).map((n) => ctx.bus.on(n, () => { eventos[n]++; }));

  /* --- monta a cena: onda 3 com o jogador invulneravel ---------------- */
  ctx.settings.set('musicVolume', 0);
  ctx.settings.set('sfxVolume', 1);
  ctx.state = 'jogando';
  ctx.menu?.hideAll?.();
  ai.reset();
  ai.spawnAutomatico = false;

  const jog = ctx.player;
  if (!jog.__blindado) {
    const orig = jog.takeDamage.bind(jog);
    jog.takeDamage = function () { return jog.health; };
    jog.__blindado = orig;
  }
  jog.alive = true; jog.health = jog.maxHealth;

  /* DEIXA A `Progressao` DIRIGIR a onda temática, em vez de montar o campo na
   * mão.
   *
   * A versão anterior fixava `ai.maxDrones` e chamava `spawnOnda` direto — e
   * perdia a disputa com o laço principal, que roda `progressao.update()` todo
   * quadro e reescreve esses mesmos campos, além de chamar `spawnOnda(...,
   * 'solo')` por conta própria. O resultado era um campo que esvaziava e não
   * voltava, e um teste medindo silêncio. Pondo a `Progressao` na onda 2 em
   * fim de intervalo, ela mesma inicia a 3 e mantém o enxame povoado — que é
   * exatamente o caminho que o jogo percorre. */
  ai.spawnAutomatico = false;
  prog.reiniciar();
  prog.onda = 2;
  prog.fase = 'intervalo';
  prog.tFase = 0;
  await esperar(4.0);   // a onda 3 começa e o enxame chega
  const nasceram = ai.contarDrones();

  /* --- o jogador ATIRANDO: a maior fonte da mixagem -------------------- */
  const dir = new V();
  const tiroJogador = setInterval(() => {
    const o = jog.eyePosition.clone();
    /* MIRA NO DRONE MAIS PRÓXIMO, e resolve o acerto pelo mesmo
     * `ai.raycastEnemies` que a arma do jogo usa.
     *
     * Isto NÃO é firula do teste: é o que faltava na passagem anterior. Atirar
     * no vazio nunca produz `enemy:damaged` nem `enemy:killed` — e são esses
     * dois eventos que disparavam um GRITO HUMANO sintetizado ao vivo (~12 nós)
     * a cada acerto. A medição anterior deu "0% de descarte, cabe folgado"
     * justamente porque o boneco não acertava nada, enquanto o jogador de
     * verdade acertava drone o tempo todo. */
    let alvo = null, melhorD = 1e9;
    for (const e of ai.getEnemies()) {
      const d = e.pos.distanceTo(o);
      if (d < melhorD) { melhorD = d; alvo = e; }
    }
    if (alvo) dir.copy(alvo.pos).sub(o).normalize();
    else ctx.camera.getWorldDirection(dir);
    // espalhamento humano: nem todo tiro acerta
    /* Espalhamento calibrado para ~30% de acerto, que e o que um jogador faz
     * contra drone em voo (medido em tools/drone.mjs). Com espalhamento menor o
     * boneco varria o enxame em um segundo e o teste voltava a medir campo
     * vazio — o mesmo defeito da passagem anterior, por outro caminho. */
    dir.x += (Math.random() - 0.5) * 0.11;
    dir.y += (Math.random() - 0.5) * 0.11;
    dir.z += (Math.random() - 0.5) * 0.11;
    dir.normalize();

    ctx.bus.emit('weapon:fire', { weapon: 'ia2', origin: o, dir: dir.clone(), spread: 0.6 });
    const er = ai.raycastEnemies(o, dir, 120);
    if (er) {
      ctx.bus.emit('weapon:hit', {
        point: er.point.clone(), normal: er.normal.clone(), surface: 'carne',
        target: 'enemy', enemyId: er.enemyId,
      });
      ai.damageEnemy(er.enemyId, 33, { point: er.point.clone(), part: er.part, weapon: 'ia2' });
    } else {
      const p2 = o.clone().addScaledVector(dir, 12);
      ctx.bus.emit('weapon:hit', {
        point: p2, normal: new V(0, 1, 0), surface: 'concreto', target: 'world', enemyId: null,
      });
    }
    A.cartucho?.(o, 1);
    // repõe o enxame: a onda temática mantém o campo cheio
    // o repovoamento e da , que roda no laco principal
  }, 1000 / (700 / 60));   // 700 rpm

  /* --- detector de travada da thread de audio -------------------------- */
  let travadas = 0, audioPerdido = 0, maxLacuna = 0;
  let lw = performance.now(), la = A.actx.currentTime;
  const amostra = setInterval(() => {
    const w = performance.now(), a = A.actx.currentTime;
    const dw = (w - lw) / 1000, da = a - la;
    lw = w; la = a;
    if (dw > 0.004) {
      const lacuna = dw - da;
      if (lacuna > dw * 0.30 && lacuna > 0.006) {
        travadas++; audioPerdido += lacuna;
        if (lacuna > maxLacuna) maxLacuna = lacuna;
      }
    }
  }, 8);

  // zera os contadores agora que a cena esta quente
  pedidos = 0; negados = 0;
  for (const k of Object.keys(porPrio)) delete porPrio[k];
  for (const k of Object.keys(chamadas)) chamadas[k] = 0;
  for (const k of Object.keys(eventos)) eventos[k] = 0;
  for (const k of Object.keys(criados)) delete criados[k];
  const baseNos = nCriados;

  const t0w = performance.now(), t0a = A.actx.currentTime;
  const serieVozes = [], serieDrones = [];
  for (let s = 0; s < DUR; s++) {
    await esperar(1);
    serieVozes.push(A.vozes);
    serieDrones.push(ai.contarDrones());
  }
  clearInterval(tiroJogador);
  clearInterval(amostra);
  for (const off of offs) off?.();

  const wall = (performance.now() - t0w) / 1000;
  const aud = A.actx.currentTime - t0a;
  const nosCriados = nCriados - baseNos;
  const est = A.estatisticas();

  A._voz = _vozOrig;
  return {
    nasceram, dronesEmCampo: ai.contarDrones(),
    pedidos, negados,
    descartePct: +(100 * negados / Math.max(1, pedidos)).toFixed(0),
    pedidosPorSeg: +(pedidos / DUR).toFixed(0),
    porPrio, serieVozes, serieDrones,
    chamadas, eventos,
    nosCriados, nosPorSeg: +(nosCriados / DUR).toFixed(0),
    criados: { ...criados },
    travadas, audioPerdidoMs: +(audioPerdido * 1000).toFixed(0),
    maxLacunaMs: +(maxLacuna * 1000).toFixed(1),
    derivaMs: +((wall - aud) * 1000).toFixed(0),
    derivaPct: +(100 * (wall - aud) / wall).toFixed(2),
    pool: est.pool, roubos: est.roubos, reaproveitados: est.reaproveitados,
    estadoCtx: A.actx.state,
  };
}, { DUR });

const NOMES = {
  100: 'danoJogador', 96: 'contrato', 88: 'tiroJogador', 84: 'aterrissagem',
  78: 'tiro(hostil)', 72: 'morte', 70: 'droneInvestida', 66: 'alerta',
  64: 'recargaHostil', 60: 'dor', 58: 'droneQueda', 56: 'impacto', 48: 'passo',
  22: 'cartucho', 12: 'ambiente',
};

const l = console.log;
l('');
l('=== ' + ROTULO + ' ===  enxame + jogador atirando a 700 rpm, ' + DUR + ' s  (ctx=' + r.estadoCtx + ')');
l('  drones: nasceram ' + r.nasceram + ', em campo ao fim ' + r.dronesEmCampo
  + '   ·   por segundo: ' + r.serieDrones.join(','));
l('');
l('  PEDIDOS DE VOZ   ' + r.pedidos + ' em ' + DUR + ' s  =  ' + r.pedidosPorSeg + '/s');
l('  NEGADOS          ' + r.negados + '   ->   DESCARTE ' + r.descartePct + '%');
l('  NOS CRIADOS      ' + r.nosCriados + '  =  ' + r.nosPorSeg + '/s');
l('  vozes ativas/s   ' + r.serieVozes.join(','));
l('  pool             ' + r.pool + '   roubos ' + r.roubos + '   reaproveitados ' + r.reaproveitados);
l('');
l('  THREAD DE AUDIO  deriva ' + r.derivaMs + ' ms (' + r.derivaPct + '% do tempo)  <- o numero honesto');
l('                   travadas ' + r.travadas + ', audio perdido ' + r.audioPerdidoMs
  + ' ms, maior lacuna ' + r.maxLacunaMs + ' ms');
l('');
l('  descarte por prioridade:');
for (const k of Object.keys(r.porPrio).sort((a, b) => b - a)) {
  const v = r.porPrio[k];
  l('    ' + String(k).padStart(4) + ' ' + (NOMES[k] || '?').padEnd(14)
    + ' pediu ' + String(v.pediu).padStart(5)
    + '  negou ' + String(v.negou).padStart(5)
    + '  (' + Math.round(100 * v.negou / v.pediu) + '%)');
}
l('');
l('  CHAMADAS x EVENTOS  — mais de uma chamada por evento = som DUPLICADO');
l('    enemy:fire   ' + String(r.eventos['enemy:fire']).padStart(5)
  + '   ->  A.tiro chamado ' + r.chamadas.tiro + ' vez(es) no total (inclui o do jogador: '
  + r.eventos['weapon:fire'] + ')');
const esperadoTiro = r.eventos['enemy:fire'] + r.eventos['weapon:fire'];
l('    esperado: ' + esperadoTiro + '   ·   obtido: ' + r.chamadas.tiro
  + (r.chamadas.tiro > esperadoTiro ? '   <<< DUPLICADO (' + (r.chamadas.tiro - esperadoTiro) + ' a mais)' : '   ok'));
l('    weapon:hit   ' + String(r.eventos['weapon:hit']).padStart(5) + '   ->  A.impacto ' + r.chamadas.impacto
  + (r.chamadas.impacto > r.eventos['weapon:hit'] ? '   <<< DUPLICADO' : '   ok'));
l('    enemy:killed ' + String(r.eventos['enemy:killed']).padStart(5) + '   enemy:damaged ' + r.eventos['enemy:damaged']
  + '   ->  A.grito ' + r.chamadas.grito + '  (grito HUMANO em maquina)');
l('    droneInvestida ' + r.chamadas.droneInvestida + '   droneQueda ' + r.chamadas.droneQueda
  + '   passo ' + r.chamadas.passo);
l('');
l('  nos por tipo:');
for (const k of Object.keys(r.criados).sort((a, b) => r.criados[b] - r.criados[a])) {
  l('    ' + k.padEnd(24) + r.criados[k]);
}

await browser.close();
vite.kill();
