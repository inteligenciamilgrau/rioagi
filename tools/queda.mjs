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
    /** Planta o jogador vivo num ponto de spawn e devolve onde ele ficou. */
    plantar(i) {
      const pts = ctx.world.getSpawnPoints() ?? [];
      const s = pts[i % pts.length];
      const p = s.position ?? s;
      ctx.menu.mostrar(null);
      ctx.state = 'jogando';
      ctx.player.queda.cancelar();
      ctx.player.alive = true;
      ctx.player.health = 100;
      ctx.player.weapons.enabled = true;
      ctx.hud.setVisible(true);
      ctx.player.movement.teleport(p.x, p.y + 0.1, p.z);
      ctx.player.movement.velocity.set(0, 0, 0);
      ctx.player.rig.reset(Math.random() * Math.PI * 2, 0);
      return { i, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) };
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
     * A camera terminou dentro de geometria?
     *
     * Duas provas independentes, porque uma so mente:
     *  - `sphereCast` com maxDist 0 num raio de 0,30 m: ha superficie encostando?
     *  - leque de 14 raios curtos: o ponto mais proximo em qualquer direcao.
     * Um ponto DENTRO de um solido tem geometria em todas as direcoes; um ponto
     * legitimamente colado numa parede tem parede de um lado so.
     */
    auditar() {
      const col = ctx.world.collision;
      const V = ctx.camera.position.constructor;
      const p = ctx.camera.position;
      const sc = col.sphereCast(p, new V(0, 1, 0), 0.30, 0);
      const dirs = [];
      for (let a = 0; a < 12; a++) {
        const th = (a / 12) * Math.PI * 2;
        dirs.push(new V(Math.cos(th), 0, Math.sin(th)));
      }
      dirs.push(new V(0, 1, 0), new V(0, -1, 0));
      let batidos = 0, minDist = Infinity;
      for (const d of dirs) {
        const r = col.raycast(p, d, 1.2);
        if (r.hit) { batidos++; minDist = Math.min(minDist, r.distance); }
      }
      const chao = col.groundAt(p.x, p.z);
      return {
        x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2),
        penetrando: !!sc.hit,
        folgaEsfera: sc.hit ? +Math.max(0, p.distanceTo(sc.point)).toFixed(3) : null,
        raiosBatidos: batidos, deQuantos: dirs.length,
        maisProximo: minDist === Infinity ? null : +minDist.toFixed(3),
        acimaDoChao: chao === -Infinity ? null : +(p.y - chao).toFixed(3),
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

const spawnFoto = 7;
await page.evaluate((i) => window.__q.plantar(i), spawnFoto);
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/00-vivo.png` });

await page.evaluate(() => window.__q.matar());
// Capturas em tempo de PAREDE, cobrindo o arco inteiro da queda.
const marcos = [90, 180, 270, 360, 470, 620, 900, 1500, 3000];
let anterior = 0;
for (let k = 0; k < marcos.length; k++) {
  await page.waitForTimeout(marcos[k] - anterior);
  anterior = marcos[k];
  await page.screenshot({ path: `${OUT}/${String(k + 1).padStart(2, '0')}-t${marcos[k]}ms.png` });
}

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
    telaAtual: ctx.menu.telaAtual,
    estado: ctx.state,
    escalaAgora: ctx.time.scale,
    travada: document.getElementById('tela-morte')?.classList.contains('travada'),
    botoesTravados: [...document.querySelectorAll('#tela-morte .bt')].every((b) => b.disabled),
  };
});
console.log(JSON.stringify(cron, null, 2));

console.log('');
checa('a queda dura entre 0,8 s e 1,8 s de parede',
  cron.fim && cron.fim.parede > 0.8 && cron.fim.parede < 1.8,
  cron.fim ? cron.fim.parede.toFixed(2) + ' s' : 'a queda nunca terminou');
checa('o tempo desacelerou de verdade', cron.escalaMin < 0.6, 'escala minima ' + cron.escalaMin);
checa('a escala voltou a 1 no fim', Math.abs(cron.escalaAgora - 1) < 1e-6, String(cron.escalaAgora));
checa('o olho desceu pelo menos 0,8 m', cron.quedaDoOlho >= 0.8, cron.quedaDoOlho + ' m');
checa('a camera se moveu em MUITOS quadros (nao foi um corte)', cron.quadrosCaindo >= 25,
  cron.quadrosCaindo + ' quadros de queda');
checa('a tela de morte so entrou DEPOIS', cron.telaAtual === 'morte');
checa('a trava de 5 s continua sendo a dona da espera',
  cron.travada === true && cron.botoesTravados === true);

/* ====================================================================== *
 * 2. A camera nao termina dentro de geometria — em varios pontos do mapa
 * ====================================================================== */
const N = Number(process.env.PONTOS ?? 24);
console.log('');
console.log(`=== fim da queda em ${N} pontos do mapa: a camera esta dentro de geometria? ===`);
console.log('  ponto  ------ posicao final ------  penetra  raios  maisProx  acimaDoChao');

const ruins = [];
const tabela = [];
for (let i = 0; i < N; i++) {
  const onde = await page.evaluate((k) => window.__q.plantar(k * 3 + 1), i);
  await page.waitForTimeout(260);
  await page.evaluate(() => window.__q.matar());
  await page.waitForTimeout(2100);
  const a = await page.evaluate(() => window.__q.auditar());
  tabela.push({ ...a, spawn: onde.i });
  const dentro = a.penetrando || (a.raiosBatidos >= 12);
  if (dentro) ruins.push({ ...a, spawn: onde.i });
  console.log(
    `  ${String(i).padStart(5)}  ${String(a.x).padStart(8)} ${String(a.y).padStart(7)} ${String(a.z).padStart(8)}` +
    `  ${(a.penetrando ? 'SIM' : 'nao').padStart(7)}  ${String(a.raiosBatidos + '/' + a.deQuantos).padStart(5)}` +
    `  ${String(a.maisProximo ?? '-').padStart(8)}  ${String(a.acimaDoChao ?? '-').padStart(11)}`);
  if (i < 4) await page.screenshot({ path: `${OUT}/fim-${String(i).padStart(2, '0')}.png` });
}

const acimaOk = tabela.filter((a) => a.acimaDoChao !== null && a.acimaDoChao >= 0.15).length;
const comChao = tabela.filter((a) => a.acimaDoChao !== null).length;
console.log('');
checa('nenhuma camera terminou DENTRO de geometria', ruins.length === 0,
  ruins.length ? ruins.map((r) => `spawn ${r.spawn}`).join(', ') : `${N}/${N} livres`);
checa('nenhuma camera atravessou o chao', acimaOk === comChao,
  `${acimaOk}/${comChao} acima de 0,15 m do piso`);

await browser.close();
vite.kill();
console.log('');
console.log(falhas === 0 ? '>>> OK' : '>>> ' + falhas + ' FALHA(S)');
process.exit(falhas === 0 ? 0 : 1);
