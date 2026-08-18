/**
 * Mede a PRESSAO de uma partida — o conjunto, nao a IA isolada.
 *
 * Subir numero de perfil de dificuldade sem medir o conjunto e chute: a
 * regeneracao (11 hp/s depois de 6,5 s), a mochila com kits, a cadencia de
 * reforco da `Progressao` e a percepcao da IA entram todos na mesma conta.
 * Aqui a conta e feita de uma vez.
 *
 * COMO
 * ----
 * Um jogador sintetico fica no ponto de nascimento e abate quem estiver a
 * vista, com um tempo-para-matar FIXO (`TTK`). Ele nao se esconde e nao recua —
 * de proposito: um alvo previsivel isola a variavel que interessa (quanta
 * pressao a IA impoe) do que seria a habilidade do jogador. O numero que sai
 * daqui NAO e "o jogo esta dificil assim"; e uma regua comparavel entre duas
 * versoes do codigo.
 *
 * Por onda: tempo ate limpar, dano tomado, mortes, pico de hostis vivos,
 * tiros da IA e quantos acertaram.
 *
 * Uso: node tools/pressao.mjs           (240 s simulados)
 *      TTK=1.2 DUR=180 node tools/pressao.mjs
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 5279);
const TTK = Number(process.env.TTK ?? 1.5);      // s de mira por abate
const DUR = Number(process.env.DUR ?? 240);      // s simulados

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

const r = await page.evaluate(async ({ TTK, DUR }) => {
  const ctx = window.__game.ctx;
  const jog = ctx.player;
  const ai = ctx.ai;
  const prog = ctx.progressao;
  const col = ctx.world.collision;
  const dt = 1 / 60;

  ctx.state = 'jogando';
  ai.reset();
  prog.reiniciar();

  const casa = jog.position.clone();
  const yawCasa = jog.rig?.yaw ?? 0;

  /* --- contabilidade --- */
  let danoTotal = 0, acertos = 0, tiros = 0, mortes = 0, abates = 0;
  const takeOrig = jog.takeDamage.bind(jog);
  /* O dano e SEMPRE contabilizado; o escudo so impede de aplicar. Sem ele a
   * queda vira loop: o boneco levanta no meio da roda e cai de novo no quadro
   * seguinte (110 quedas numa onda, medido). Com 2,5 s de folga, a queda volta
   * a significar "a IA entregou 100 hp", que e o que se quer comparar. */
  jog.takeDamage = function (d, dir, src) {
    danoTotal += d; acertos++;
    if (escudo > 0) return this.health;
    return takeOrig(d, dir, src);
  };
  const offFogo = ctx.bus.on('enemy:fire', () => tiros++);

  const porOnda = [];
  let ondaAtual = 0, tOnda = 0, danoOnda = 0, mortesOnda = 0, picoOnda = 0;
  let tiroOnda = 0, acertoOnda = 0, abateOnda = 0;
  const marcarOnda = (n) => {
    if (ondaAtual > 0) {
      porOnda.push({
        onda: ondaAtual, t: +tOnda.toFixed(1), dano: Math.round(danoOnda),
        mortes: mortesOnda, pico: picoOnda, tiros: tiroOnda, acertos: acertoOnda,
        abates: abateOnda,
      });
    }
    ondaAtual = n; tOnda = 0; danoOnda = 0; mortesOnda = 0; picoOnda = 0;
    tiroOnda = 0; acertoOnda = 0; abateOnda = 0;
  };

  let tMira = 0, alvoId = -1, escudo = 0;
  const _o = new (jog.position.constructor)();
  const _d = new (jog.position.constructor)();

  /* Censo: a cada 20 s, em que estado e a que distancia esta cada hostil.
   * Sem isto "o combate esta ralo" nao diz ONDE trava — se ninguem nasce, se
   * nascem e nao chegam, ou se chegam e nao atiram. */
  const censo = [];
  const n = Math.round(60 * DUR);
  for (let i = 0; i < n; i++) {
    if (i % 1200 === 0) {
      const est = {}; const dd = [];
      for (const e of ai.getEnemies()) {
        est[e.estado] = (est[e.estado] ?? 0) + 1;
        dd.push(Math.round(e.pos.distanceTo(jog.position)));
      }
      censo.push({ t: Math.round(i / 60), onda: prog.onda, fase: prog.fase,
        vivos: dd.length, est, dist: dd.sort((a, b) => a - b).join(','),
        vida: Math.round(jog.health) });
    }
    const danoAntes = danoTotal, tirosAntes = tiros;

    if (escudo > 0) escudo -= dt;
    jog.update(dt);
    ai.update(dt);
    prog.update(dt);

    danoOnda += danoTotal - danoAntes;
    acertoOnda += (danoTotal > danoAntes) ? 1 : 0;
    tiroOnda += tiros - tirosAntes;
    tOnda += dt;

    if (prog.onda !== ondaAtual) marcarOnda(prog.onda);

    /* --- jogador sintetico: abate quem estiver a vista --- */
    const vivos = ai.getEnemies();
    if (vivos.length > picoOnda) picoOnda = vivos.length;
    _o.copy(jog.eyePosition);
    let melhor = null, melhorD = 42;
    for (const e of vivos) {
      const d = e.pos.distanceTo(jog.position);
      if (d > melhorD) continue;
      _d.copy(e.pos); _d.y += 1.2; _d.sub(_o);
      const dd = _d.length(); _d.divideScalar(dd);
      const h = col.raycast(_o, _d, dd - 0.3);
      if (h && h.hit) continue;       // sem visada: nao da para abater
      melhor = e; melhorD = d;
    }
    if (melhor) {
      if (melhor.id !== alvoId) { alvoId = melhor.id; tMira = 0; }
      tMira += dt;
      if (tMira >= TTK) {
        ai.damageEnemy(melhor.id, 500, melhor.pos.clone(), 'torso', 'ia2');
        abates++; abateOnda++; tMira = 0; alvoId = -1;
      }
    } else { alvoId = -1; tMira = 0; }

    /* --- caiu: conta, levanta NO LUGAR e segue ---
     *
     * As duas alternativas obvias falseiam a medicao de formas opostas:
     * renascer num ponto sorteado do mapa TELEPORTA o boneco para longe do
     * tiroteio (censo medido logo apos uma morte: hostis a 132, 141 e 176 m —
     * a onda inteira virou caminhada), e chamar respawn no mesmo ponto reencena
     * a morte a cada quadro (82 quedas numa unica onda). Levantar no lugar
     * mantem a geometria constante entre as duas versoes comparadas.
     *
     * LEIA A QUEDA COMO PROXY DE PRESSAO, NAO COMO DIFICULDADE REAL: este
     * boneco nunca anda, nunca se abaixa e nunca procura parede. Ele mede
     * quanto a IA IMPOE, nao quanto um jogador aguenta. */
    if (!jog.alive) {
      mortes++; mortesOnda++;
      jog.alive = true;
      jog.health = jog.maxHealth;
      jog._sinceDamage = 99;
      jog.weapons.enabled = true;
      escudo = 2.5;
      void casa; void yawCasa;
      /* ARMADILHA: `Player._die()` poe `ctx.state = 'morto'` e o `respawn()`
       * NAO desfaz isso (quem desfaz e o menu). Sem esta linha a medicao
       * congela na primeira morte: `Progressao.update` e o repovoamento do
       * `AIManager` so rodam com `state === 'jogando'`, e o resto da corrida
       * fica com o campo vazio — foi o que produziu "onda 3/intervalo,
       * vivos=0" por 60 s seguidos num laudo anterior. */
      ctx.state = 'jogando';
      if (prog.fase === 'fim') prog.fase = 'combate';
    }
  }
  marcarOnda(-1);

  jog.takeDamage = takeOrig;
  offFogo?.();

  return {
    censo, porOnda, danoTotal: Math.round(danoTotal), tiros, acertos, mortes, abates,
    ondaFinal: prog.onda,
    perfilFinal: (() => {
      const p = prog.perfilDaOnda(prog.onda);
      return { reacao: p.reacao.map((x) => +x.toFixed(2)), erroMin: +p.erroMin.toFixed(3), dano: +p.dano.toFixed(1) };
    })(),
  };
}, { TTK, DUR });

console.log('');
console.log('PRESSAO — jogador sintetico parado, TTK ' + TTK + ' s, ' + DUR + ' s simulados');
console.log('');
console.log('  onda  dur(s)  dano   mortes  pico  abates  tiros IA  acertos  %');
for (const o of r.porOnda) {
  const pct = o.tiros ? (100 * o.acertos / o.tiros).toFixed(0) : '-';
  console.log('   ' + String(o.onda).padStart(2) + '    ' + String(o.t).padStart(6)
    + '  ' + String(o.dano).padStart(5) + '   ' + String(o.mortes).padStart(4)
    + '   ' + String(o.pico).padStart(3) + '    ' + String(o.abates).padStart(4)
    + '    ' + String(o.tiros).padStart(6) + '    ' + String(o.acertos).padStart(5)
    + '   ' + String(pct).padStart(3));
}
console.log('');
console.log('  censo (t, onda, vivos, estados, distancias, vida):');
for (const c of r.censo) {
  console.log('   t=' + String(c.t).padStart(3) + 's onda ' + c.onda + '/' + c.fase
    + ' vivos=' + c.vivos + ' vida=' + String(c.vida).padStart(3)
    + '  ' + JSON.stringify(c.est) + '  d=[' + c.dist + ']');
}
console.log('');
console.log('  total: dano ' + r.danoTotal + '  ·  mortes ' + r.mortes + '  ·  abates ' + r.abates
  + '  ·  tiros da IA ' + r.tiros + '  ·  acertos ' + r.acertos
  + ' (' + (r.tiros ? (100 * r.acertos / r.tiros).toFixed(1) : '-') + '%)');
console.log('  dano por minuto: ' + (r.danoTotal / (DUR / 60)).toFixed(0)
  + '   ·   onda alcancada: ' + r.ondaFinal
  + '   ·   perfil final: reacao ' + r.perfilFinal.reacao.join('-')
  + ' erroMin ' + r.perfilFinal.erroMin + ' dano ' + r.perfilFinal.dano);

await browser.close();
vite.kill();
