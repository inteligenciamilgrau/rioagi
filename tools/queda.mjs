/**
 * queda.mjs — a encenacao da morte, medida e fotografada.
 *
 * Tres perguntas, nesta ordem:
 *
 *  1. QUANTO DURA de relogio de parede, e a tela final so entra depois?
 *     Camera lenta que vira camera travada e pior do que morte seca.
 *  2. A CAMERA TERMINA DENTRO DE GEOMETRIA? Medido em muitos pontos do mapa,
 *     porque isto so aparece no beco apertado, na quina, embaixo do beiral —
 *     nunca no meio da rua onde e comodo testar.
 *  3. COMO E que a queda FICA? Sequencia de capturas para olhar.
 *
 * ARMADILHAS PAGAS (nao repita):
 *  - `page.evaluate` BLOQUEIA o laco de rAF. Toda a encenacao roda no rAF, entao
 *    nada de rodar a queda dentro de um evaluate sincrono: aqui o evaluate so
 *    ARMA a morte e devolve; quem espera e o Node, com `waitForTimeout`.
 *  - A primeira captura sai com o menu por cima. Ha uma de aquecimento,
 *    descartada.
 *  - Matar por `takeDamage` exige `alive === true` e vida > 0; e `respawn()`
 *    sorteia ponto, entao para plantar o jogador num lugar escolhido e preciso
 *    `movement.teleport` DEPOIS do respawn.
 *
 * Uso: node tools/queda.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 5284);
const OUT = 'shots/queda';
mkdirSync(OUT, { recursive: true });

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
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE:', m.text().slice(0, 160)); });
await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready, undefined, { timeout: 240000 });
await page.waitForTimeout(2000);

let falhas = 0;
const checa = (n, ok, d = '') => {
  console.log((ok ? '  OK  ' : ' FALHA') + '  ' + n + (d ? '   ' + d : ''));
  if (!ok) falhas++;
};

/* Instrumento: planta o jogador num spawn, mata-o, e registra a trilha da
 * camera quadro a quadro a partir do proprio rAF. */
await page.evaluate(() => {
  const ctx = window.__game.ctx;
  window.__q = {
    trilha: [],
    fim: null,
    _off: null,
    /**
     * Planta o jogador vivo num ponto de spawn e devolve onde ele ficou.
     *
     * `encostar` empurra o boneco contra a parede mais proxima e o vira de
     * cara para ela — e o caso ADVERSARIAL, o unico que interessa para a
     * pergunta "a camera termina dentro de geometria". Morrer no meio da rua
     * nao prova nada: a queda tem 0,64 m de alcance e ali sobra mundo.
     */
    plantar(i, encostar = false, yaw = null) {
      const pts = ctx.world.getSpawnPoints() ?? [];
      const s = pts[i % pts.length];
      const p = s.position ?? s;
      const V = ctx.camera.position.constructor;
      ctx.menu.mostrar(null);
      ctx.state = 'jogando';
      ctx.player.queda.cancelar();
      ctx.player.alive = true;
      ctx.player.health = 100;
      ctx.player.weapons.enabled = true;
      ctx.hud.setVisible(true);
      ctx.player.movement.teleport(p.x, p.y + 0.1, p.z);
      ctx.player.movement.velocity.set(0, 0, 0);

      let rumo = yaw ?? 0;
      if (encostar) {
        // Acha a parede mais proxima na altura do peito e cola nela.
        const col = ctx.world.collision;
        const o = new V(p.x, p.y + 1.1, p.z);
        let melhor = null, melhorD = Infinity;
        for (let a = 0; a < 24; a++) {
          const th = (a / 24) * Math.PI * 2;
          const d = new V(Math.sin(th), 0, Math.cos(th));
          const r = col.raycast(o, d, 6);
          if (r.hit && r.distance < melhorD) { melhorD = r.distance; melhor = { d, th }; }
        }
        if (melhor && melhorD < 6) {
          const avanco = Math.max(0, melhorD - 0.45);
          ctx.player.movement.teleport(
            p.x + melhor.d.x * avanco, p.y + 0.1, p.z + melhor.d.z * avanco);
          // yaw tal que a frente da camera, (-sin, 0, -cos), aponte para a parede
          rumo = Math.atan2(-melhor.d.x, -melhor.d.z);
        } else {
          rumo = Math.random() * Math.PI * 2;
        }
      } else if (yaw === 'melhor') {
        /* O rumo que o proprio jogo escolheria ao renascer ali (o leque de
         * `Player._rumoInicial`, que pontua casario contra mato e vazio).
         * Para a sequencia de fotos isso importa: um spawn de crista pelada
         * enquadra so terra, e a tomada e julgada pelo lugar, nao pela queda. */
        rumo = ctx.player._rumoInicial(ctx.player.movement.position);
      } else if (yaw === null) {
        rumo = Math.random() * Math.PI * 2;
      }
      ctx.player.rig.reset(rumo, 0);
      ctx.player.rig.update(0.016, { position: ctx.player.movement.position, eyeHeight: 1.68 });
      return {
        i, encostada: encostar,
        x: +ctx.player.movement.position.x.toFixed(2),
        y: +ctx.player.movement.position.y.toFixed(2),
        z: +ctx.player.movement.position.z.toFixed(2),
      };
    },
    /** Mata e comeca a gravar. NAO espera: quem espera e o Node (o rAF roda la fora). */
    matar() {
      this.trilha = [];
      this.fim = null;
      const t0 = performance.now();
      const dir = new (ctx.camera.position.constructor)(
        Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
      if (this._off) this._off();
      this._off = ctx.bus.on('player:caiu', (p) => {
        this.fim = { parede: (performance.now() - t0) / 1000, duracao: p.duracao };
      });
      ctx.player.takeDamage(999, dir, 'medicao');
      const amostra = () => {
        const c = ctx.camera;
        this.trilha.push({
          t: (performance.now() - t0) / 1000,
          estado: ctx.state,
          escala: +ctx.time.scale.toFixed(3),
          x: c.position.x, y: c.position.y, z: c.position.z,
        });
        if (this.trilha.length < 400 && ctx.state !== 'morto') requestAnimationFrame(amostra);
      };
      requestAnimationFrame(amostra);
    },
    /**
     * A camera terminou DENTRO de geometria?
     *
     * O CRITERIO CERTO NAO E "ha superficie perto".
     *
     * A primeira versao desta funcao usou `sphereCast(p, dir, 0.30, 0)` e
     * reprovou 6 de 6 pontos — todos com a superficie a 0,30 m exatos. Era o
     * instrumento medindo a propria correcao: a depenetracao POE o olho a
     * `RAIO_OLHO` da geometria mais proxima, entao "ha algo dentro de 0,30 m"
     * e verdade por construcao em toda queda que termina no chao. Aquilo nao
     * media penetracao, media contato.
     *
     * O criterio que separa os dois casos e a ENVOLTURA: um ponto dentro de um
     * solido tem geometria a curta distancia em TODAS as direcoes (o raio sai
     * pela face de saida); um ponto legitimamente deitado no chao, ou encostado
     * numa parede, tem geometria em uma ou duas direcoes e ceu no resto.
     * Entao: leque de 26 direcoes (12 no plano, 8 diagonais, 6 nos eixos), e
     * conta-se quantas batem a menos de `PERTO`.
     */
    auditar() {
      const col = ctx.world.collision;
      const V = ctx.camera.position.constructor;
      const p = ctx.camera.position;
      const PERTO = 0.26;              // abaixo do raio de seguranca de 0,30

      const dirs = [];
      for (let a = 0; a < 12; a++) {
        const th = (a / 12) * Math.PI * 2;
        dirs.push(new V(Math.cos(th), 0, Math.sin(th)));
      }
      for (const sy of [1, -1]) {
        for (let a = 0; a < 4; a++) {
          const th = (a / 4) * Math.PI * 2 + Math.PI / 4;
          dirs.push(new V(Math.cos(th) * 0.7071, sy * 0.7071, Math.sin(th) * 0.7071));
        }
      }
      dirs.push(new V(0, 1, 0), new V(0, -1, 0));

      let curtos = 0, minDist = Infinity;
      for (const d of dirs) {
        const r = col.raycast(p, d, 2.0);
        if (!r.hit) continue;
        minDist = Math.min(minDist, r.distance);
        if (r.distance < PERTO) curtos++;
      }
      const sc = col.sphereCast(p, new V(0, 1, 0), 0.30, 0);
      /* Altura sobre o piso: sonda LOCAL, saindo de LOGO acima do olho.
       *
       * Duas versoes erradas antes desta, e as duas pelo mesmo motivo — o raio
       * achou TETO em vez de piso:
       *  - `groundAt` sai de y=200 e acerta o telhado quando a camera esta
       *    dentro de casa (medido: -59,8 m num ponto perfeitamente valido);
       *  - sair de `olho + 2,0 m` acerta a laje ou o beiral que passa a menos
       *    de 2 m sobre a cabeca (medido: -1,37 m em dois pontos).
       * De `olho + 0,10 m` nao ha o que acertar acima. E a mesma armadilha ja
       * registrada em NOTES para a altitude do drone. */
      const rc = col.raycast(new V(p.x, p.y + 0.10, p.z), new V(0, -1, 0), 6);
      const chao = rc.hit ? rc.point.y : -Infinity;
      const alturaChao = rc.hit ? p.y - rc.point.y : null;
      return {
        x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2),
        curtos, deQuantos: dirs.length,
        maisProximo: minDist === Infinity ? null : +minDist.toFixed(3),
        contato: sc.hit ? +p.distanceTo(sc.point).toFixed(3) : null,
        acimaDoChao: alturaChao === null ? null : +alturaChao.toFixed(3),
      };
    },
  };
});

// Aquecimento: a primeira composicao sai com o menu por cima. Descartada.
await page.evaluate(() => window.__q.plantar(0));
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/_aquecimento.png` });

/* ====================================================================== *
 * 1 e 3. A queda: cronometro e sequencia de capturas
 * ====================================================================== */
console.log('');
console.log('=== a queda, quadro a quadro ===');

/* UMA MORTE POR CAPTURA, de proposito.
 *
 * A primeira versao matava uma vez e tirava as nove fotos em sequencia com
 * `waitForTimeout(marco - anterior)`. Nao vale: `page.screenshot()` leva de
 * 200 a 600 ms com swiftshader, e esse tempo NAO entrava na conta — o quadro
 * rotulado "t=180 ms" era na verdade o de ~1 s, com o corpo ja no chao. A
 * sequencia inteira mentia sobre o proprio eixo do tempo.
 *
 * Aqui cada marco e uma morte nova: planta no MESMO ponto, com o MESMO rumo,
 * mata, espera o marco e fotografa uma vez so. Com `queda.determinista` a
 * queda e reproduzivel (mesma direcao, mesmo empurrao inicial), entao as nove
 * fotos formam de fato uma sequencia. */
/* O ponto da sequencia de fotos NAO e escolhido a dedo.
 *
 * A primeira versao fixou o spawn 7 e a tomada saiu enquadrando so barranco de
 * terra — o julgamento "a queda emociona?" virou julgamento do lugar. Aqui
 * pedimos ao proprio jogo: `Player._avaliarPonto` e a mesma nota que o
 * `respawn()` usa para nao devolver o jogador de cara no mato, entao o ponto
 * escolhido e representativo de onde o jogador de fato renasce. */
const spawnFoto = await page.evaluate(() => {
  const ctx = window.__game.ctx;
  const pts = ctx.world.getSpawnPoints() ?? [];
  let melhor = 0, nota = -Infinity;
  for (let i = 0; i < Math.min(pts.length, 60); i++) {
    const p = pts[i].position ?? pts[i];
    const n = ctx.player._avaliarPonto(p).nota;
    if (n > nota) { nota = n; melhor = i; }
  }
  return melhor;
});
const yawFoto = 'melhor';
console.log(`  (sequencia fotografada no spawn ${spawnFoto}, o de melhor vista entre 60)`);
await page.evaluate(() => { window.__game.ctx.player.queda.determinista = true; });

await page.evaluate(([i, y]) => window.__q.plantar(i, false, y), [spawnFoto, yawFoto]);
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/00-vivo.png` });

const marcos = [80, 160, 260, 380, 520, 700, 900, 1150, 1500, 2400];
for (let k = 0; k < marcos.length; k++) {
  await page.evaluate(([i, y]) => window.__q.plantar(i, false, y), [spawnFoto, yawFoto]);
  await page.waitForTimeout(320);
  await page.evaluate(() => window.__q.matar());
  await page.waitForTimeout(marcos[k]);
  await page.screenshot({ path: `${OUT}/${String(k + 1).padStart(2, '0')}-t${marcos[k]}ms.png` });
}

// A ultima morte fica de pe para o cronometro (a de 2400 ms ja terminou).
await page.evaluate(([i, y]) => window.__q.plantar(i, false, y), [spawnFoto, yawFoto]);
await page.waitForTimeout(320);
await page.evaluate(() => window.__q.matar());
await page.waitForTimeout(1900);

// A trava de 5 s tem de ser conferida AGORA, colada no fim da queda: mais
// tarde ela expira sozinha e o teste reprovaria uma coisa que funciona.
const trava = await page.evaluate(() => ({
  telaAtual: window.__game.ctx.menu.telaAtual,
  travada: document.getElementById('tela-morte')?.classList.contains('travada'),
  botoesTravados: [...document.querySelectorAll('#tela-morte .bt')].every((b) => b.disabled),
  cursorEscondido: getComputedStyle(document.getElementById('tela-morte')).cursor === 'none',
}));
await page.screenshot({ path: `${OUT}/20-tela-de-morte.png` });

const cron = await page.evaluate(() => {
  const t = window.__q.trilha;
  const ctx = window.__game.ctx;
  const y0 = t.length ? t[0].y : 0;
  const yMin = Math.min(...t.map((a) => a.y));
  const escalaMin = Math.min(...t.map((a) => a.escala));
  const iCaindo = t.filter((a) => a.estado === 'caindo');
  return {
    fim: window.__q.fim,
    quadros: t.length,
    quadrosCaindo: iCaindo.length,
    escalaMin: +escalaMin.toFixed(3),
    quedaDoOlho: +(y0 - yMin).toFixed(2),
    estado: ctx.state,
    escalaAgora: ctx.time.scale,
  };
});
console.log(JSON.stringify({ ...cron, ...trava }, null, 2));

console.log('');
checa('a queda dura entre 0,8 s e 1,8 s de parede',
  cron.fim && cron.fim.parede > 0.8 && cron.fim.parede < 1.8,
  cron.fim ? cron.fim.parede.toFixed(2) + ' s' : 'a queda nunca terminou');
checa('o tempo desacelerou de verdade', cron.escalaMin < 0.6, 'escala minima ' + cron.escalaMin);
checa('a escala voltou a 1 no fim', Math.abs(cron.escalaAgora - 1) < 1e-6, String(cron.escalaAgora));
checa('o olho desceu pelo menos 0,8 m', cron.quedaDoOlho >= 0.8, cron.quedaDoOlho + ' m');
checa('a camera se moveu em MUITOS quadros (nao foi um corte)', cron.quadrosCaindo >= 25,
  cron.quadrosCaindo + ' quadros de queda');
checa('a tela de morte so entrou DEPOIS da queda', trava.telaAtual === 'morte');
checa('a trava de 5 s continua sendo a dona da espera',
  trava.travada === true && trava.botoesTravados === true);
checa('o cursor segue escondido durante a trava', trava.cursorEscondido === true);

/* ====================================================================== *
 * 1b. A VOLTA: cair, apertar "Tentar de novo", jogar de novo
 * ====================================================================== *
 * A encenacao mexe em `ctx.state` e em `ctx.time.scale`, e as duas coisas
 * ficariam presas se alguem esquecesse de desfazer. Escala presa em 0,42 e o
 * pior defeito possivel aqui: o jogo inteiro passaria a rodar a 42% da
 * velocidade e ninguem ligaria a causa a tela de morte.
 */
console.log('');
console.log('=== a volta: morrer, reiniciar, morrer de novo ===');
await page.waitForTimeout(5200);                 // deixa a trava de 5 s liberar
const volta = await page.evaluate(() => {
  const ctx = window.__game.ctx;
  ctx.menu._acao('reiniciar');
  return { estado: ctx.state, escala: ctx.time.scale, vivo: ctx.player.alive, tela: ctx.menu.telaAtual };
});
await page.waitForTimeout(700);
const voltaDepois = await page.evaluate(() => {
  const ctx = window.__game.ctx;
  const antes = ctx.time.frame;
  return new Promise((res) => setTimeout(() => res({
    quadros: ctx.time.frame - antes,
    escala: ctx.time.scale,
    estado: ctx.state,
    vida: ctx.player.health,
    quedaAtiva: ctx.player.queda.ativa,
    armaVisivel: ctx.player.viewModel.quedaT,
  }), 500));
});
checa('reiniciar volta para jogando', volta.estado === 'jogando', volta.estado);
checa('a escala de tempo volta a 1', voltaDepois.escala === 1, String(voltaDepois.escala));
checa('o jogador esta vivo e inteiro', voltaDepois.vida === 100 && volta.vivo === true);
checa('a encenacao foi cancelada', voltaDepois.quedaAtiva === false);
checa('a arma voltou para a mao', voltaDepois.armaVisivel === 0, String(voltaDepois.armaVisivel));
checa('o laco voltou a rodar a 60 Hz', voltaDepois.quadros >= 20, voltaDepois.quadros + ' quadros em 0,5 s');

// E morre de novo: a segunda encenacao tem de acontecer igual a primeira.
await page.evaluate(() => window.__q.matar());
await page.waitForTimeout(1900);
const segunda = await page.evaluate(() => ({
  fim: window.__q.fim, tela: window.__game.ctx.menu.telaAtual,
  travada: document.getElementById('tela-morte')?.classList.contains('travada'),
}));
checa('a segunda morte tambem encena', segunda.fim && segunda.fim.parede > 0.8,
  segunda.fim ? segunda.fim.parede.toFixed(2) + ' s' : 'nao encenou');
checa('e a tela volta travada', segunda.tela === 'morte' && segunda.travada === true);

/* ====================================================================== *
 * 2. A camera nao termina dentro de geometria — em varios pontos do mapa
 * ====================================================================== */
const N = Number(process.env.PONTOS ?? 20);
console.log('');
console.log(`=== fim da queda em ${N * 2} quedas (${N} pontos, cada um no aberto e ENCOSTADO na parede) ===`);
console.log('  Criterio de "dentro": mais de 8 das 26 direcoes com geometria a menos de 0,26 m.');
console.log('');
console.log('  ponto  onde        ---- posicao final ----   curtos/26  maisProx  contato  acimaChao');

await page.evaluate(() => { window.__game.ctx.player.queda.determinista = false; });
const ruins = [];
const tabela = [];
let foto = 0;
for (let i = 0; i < N; i++) {
  for (const encostar of [false, true]) {
    const onde = await page.evaluate(
      ([k, e]) => window.__q.plantar(k * 3 + 1, e), [i, encostar]);
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__q.matar());
    await page.waitForTimeout(2000);
    const a = await page.evaluate(() => window.__q.auditar());
    const reg = { ...a, spawn: onde.i, encostada: encostar };
    tabela.push(reg);
    if (a.curtos > 8) ruins.push(reg);
    console.log(
      `  ${String(i).padStart(5)}  ${(encostar ? 'na parede' : 'no aberto').padEnd(10)}` +
      `  ${String(a.x).padStart(8)} ${String(a.y).padStart(7)} ${String(a.z).padStart(8)}` +
      `  ${String(a.curtos).padStart(9)}  ${String(a.maisProximo ?? '-').padStart(8)}` +
      `  ${String(a.contato ?? '-').padStart(7)}  ${String(a.acimaDoChao ?? '-').padStart(9)}`);
    if (encostar && foto < 4) {
      await page.screenshot({ path: `${OUT}/parede-${String(foto++).padStart(2, '0')}.png` });
    }
  }
}

const acimaOk = tabela.filter((a) => a.acimaDoChao !== null && a.acimaDoChao >= 0.15).length;
const comChao = tabela.filter((a) => a.acimaDoChao !== null).length;
const semFolga = tabela.filter((a) => a.maisProximo !== null && a.maisProximo < 0.20);
console.log('');
checa('nenhuma camera terminou DENTRO de geometria', ruins.length === 0,
  ruins.length ? ruins.map((r) => `spawn ${r.spawn}${r.encostada ? ' (parede)' : ''}`).join(', ')
    : `${tabela.length}/${tabela.length} livres`);
checa('nenhuma camera atravessou o chao', acimaOk === comChao,
  `${acimaOk}/${comChao} acima de 0,15 m do piso`);
checa('sempre sobra pelo menos 0,20 m ate a geometria mais proxima', semFolga.length === 0,
  semFolga.length ? `${semFolga.length} caso(s), o pior a ${Math.min(...semFolga.map((s) => s.maisProximo))} m`
    : `pior caso ${Math.min(...tabela.filter((a) => a.maisProximo !== null).map((a) => a.maisProximo)).toFixed(3)} m`);

await browser.close();
vite.kill();
console.log('');
console.log(falhas === 0 ? '>>> OK' : '>>> ' + falhas + ' FALHA(S)');
process.exit(falhas === 0 ? 0 : 1);
