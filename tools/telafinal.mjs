/**
 * telafinal.mjs — quanto custa um QUADRO nas telas do fim da vida.
 *
 * O relato foi "nas telas finais o jogo trava bastante". Isto mede, nao supoe.
 *
 * METODOLOGIA (a mesma armadilha ja paga em custofolha.mjs):
 * comparar ms/quadro entre DUAS execucoes nao vale nada nesta maquina — o
 * rasterizador e swiftshader (CPU) e outro agente rodando Playwright muda o
 * mesmo quadro de 6 ms para 25 ms. Entao todo par A/B e medido na MESMA
 * execucao, em BLOCOS ALTERNADOS, e o que se reporta e a mediana de cada lado.
 *
 * E nao se mede com `engine.render()` em rajada (como custofolha faz): a tela
 * de morte e DOM por cima do canvas, e o custo dela e de COMPOSICAO do
 * navegador, que so aparece num quadro de verdade. Aqui o relogio e o
 * requestAnimationFrame real, com o laco do jogo rodando por baixo.
 *
 * Uso: node tools/telafinal.mjs
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 5281);

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
  args: [
    '--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--mute-audio',
    // Sem isto o rAF fica preso em 60 Hz e toda medida abaixo do teto vira 16,7.
    '--disable-gpu-vsync', '--disable-frame-rate-limit',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERR:', String(e).split('\n')[0]));
await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready, undefined, { timeout: 240000 });
await page.waitForTimeout(2500);

// Instrumento dentro da pagina: mede o periodo real do rAF e sabe montar cada cenario.
await page.evaluate(() => {
  const ctx = window.__game.ctx;
  window.__tf = {
    _renderOriginal: null,
    /**
     * Mede `n` quadros REAIS. Devolve mediana, p95 e maximo — "travar" e
     * PICO de quadro, nao media: um quadro de 90 ms no meio de sessenta de
     * 11 ms desaparece na media e e exatamente o que o jogador sente.
     */
    async quadros(n) {
      const ts = [];
      await new Promise((res) => {
        const passo = (t) => { ts.push(t); if (ts.length <= n) requestAnimationFrame(passo); else res(); };
        requestAnimationFrame(passo);
      });
      const d = [];
      for (let i = 1; i < ts.length; i++) d.push(ts[i] - ts[i - 1]);
      d.sort((a, b) => a - b);
      return { med: d[d.length >> 1], p95: d[Math.min(d.length - 1, Math.floor(d.length * 0.95))], max: d[d.length - 1] };
    },
    /** Enche o campo como numa onda de verdade: hostis vivos, corpos, particulas. */
    async popular(n = 10) {
      const ctx = window.__game.ctx;
      ctx.state = 'jogando';
      ctx.player.alive = true; ctx.player.health = 100;
      ctx.ai.reset?.();
      ctx.ai.spawnAutomatico = false;
      ctx.ai.spawnOnda?.(n, 10, 40);
      // Deixa a IA andar e atirar por uns segundos: e assim que nascem corpos,
      // decais, particulas e ragdolls — o estado real em que alguem morre.
      const t0 = performance.now();
      while (performance.now() - t0 < 6000) {
        await new Promise((r) => requestAnimationFrame(r));
      }
      // Derruba metade: ragdoll e carcaca sao parte do custo do campo.
      const vivos = (ctx.ai.pool ?? []).filter((e) => e?.ativo);
      for (let i = 0; i < vivos.length >> 1; i++) {
        ctx.ai.damageEnemy?.(vivos[i].id, 9999, { point: vivos[i].objeto3d?.position });
      }
      const t1 = performance.now();
      while (performance.now() - t1 < 1200) {
        await new Promise((r) => requestAnimationFrame(r));
      }
      return {
        vivos: (ctx.ai.pool ?? []).filter((e) => e?.ativo).length,
        ragdolls: (ctx.ai.pool ?? []).filter((e) => e?.ragdoll?.ativo).length,
      };
    },
    /** Monta um cenario pelo nome. */
    cena(nome) {
      const el = (s) => document.querySelector(s);
      const menuRoot = document.getElementById('menu-root');
      // desfaz tudo antes de montar
      if (this._renderOriginal) { ctx.engine.render = this._renderOriginal; this._renderOriginal = null; }
      if (menuRoot) menuRoot.style.display = '';
      const sangria = el('#tela-morte .sangria');
      if (sangria) sangria.style.display = '';
      for (const g of document.querySelectorAll('.fundo-grao')) g.style.display = '';

      if (nome === 'jogando') {
        ctx.menu.mostrar(null); ctx.state = 'jogando';
        ctx.player.alive = true; ctx.player.health = 100; ctx.hud.setVisible(true);
        return;
      }
      // todos os demais partem da tela de morte montada como o jogo monta
      ctx.state = 'morto'; ctx.player.alive = false;
      ctx.hud.setVisible(false);
      ctx.menu.mostrar('morte');
      if (nome === 'morte') return;
      if (nome === 'morte-sem-sangria') { if (sangria) sangria.style.display = 'none'; return; }
      if (nome === 'morte-sem-dom') { if (menuRoot) menuRoot.style.display = 'none'; return; }
      if (nome === 'morte-sem-3d') {
        this._renderOriginal = ctx.engine.render.bind(ctx.engine);
        ctx.engine.render = () => {};
        return;
      }
      if (nome === 'menu') { ctx.menu.mostrar('menu'); return; }
      if (nome === 'menu-sem-grao') {
        ctx.menu.mostrar('menu');
        for (const g of document.querySelectorAll('.fundo-grao')) g.style.display = 'none';
        return;
      }
      if (nome === 'menu-grao-sem-blend') {
        // Separa o custo do FILTRO SVG do custo da CAMADA de mistura: o
        // `mix-blend-mode: overlay` obriga o navegador a uma passada de
        // composicao a mais, tenha filtro ou nao.
        ctx.menu.mostrar('menu');
        for (const g of document.querySelectorAll('.fundo-grao')) g.style.mixBlendMode = 'normal';
        return;
      }
      if (nome === 'pausa') { ctx.state = 'pausado'; ctx.menu.mostrar('pausa'); return; }
    },
  };
  // `cena()` tem de desfazer tambem o blend, senao o cenario seguinte herda.
  const cenaBase = window.__tf.cena.bind(window.__tf);
  window.__tf.cena = (nome) => {
    for (const g of document.querySelectorAll('.fundo-grao')) g.style.mixBlendMode = '';
    return cenaBase(nome);
  };
});

/** Roda um grupo de cenarios em blocos alternados e devolve a mediana de cada metrica. */
async function comparar(nomes, blocos = 5, quadros = 45) {
  const acc = Object.fromEntries(nomes.map((n) => [n, []]));
  for (let b = 0; b < blocos; b++) {
    for (const n of nomes) {
      await page.evaluate((nome) => window.__tf.cena(nome), n);
      await page.waitForTimeout(260);                       // deixa o layout assentar
      await page.evaluate((q) => window.__tf.quadros(q), 12); // descarta o aquecimento
      acc[n].push(await page.evaluate((q) => window.__tf.quadros(q), quadros));
    }
  }
  const mediana = (v) => { const s = v.slice().sort((a, b) => a - b); return s[s.length >> 1]; };
  const out = {};
  for (const n of nomes) {
    out[n] = {
      med: mediana(acc[n].map((x) => x.med)),
      p95: mediana(acc[n].map((x) => x.p95)),
      max: Math.max(...acc[n].map((x) => x.max)),
    };
  }
  return out;
}

const linha = (rot, o, extra = '') =>
  console.log(`  ${rot.padEnd(30)}${o.med.toFixed(2).padStart(7)} ${o.p95.toFixed(2).padStart(7)} ${o.max.toFixed(1).padStart(7)}   ${extra}`);
const cabecalho = () => console.log(`  ${''.padEnd(30)}${'med'.padStart(7)} ${'p95'.padStart(7)} ${'max'.padStart(7)}`);

// Aquecimento descartado: a primeira composicao sai sempre com o menu por cima.
await page.evaluate(() => window.__tf.cena('menu'));
await page.waitForTimeout(600);
await page.screenshot({ path: 'shots/queda/_aquecimento.png' }).catch(() => {});

console.log('');
console.log('=== CAMPO VAZIO — ms por quadro (5 blocos x 45 quadros, alternados) ===');
cabecalho();
const r = await comparar(['jogando', 'morte', 'morte-sem-sangria', 'morte-sem-dom', 'morte-sem-3d']);
linha('jogando (referencia)', r['jogando']);
linha('TELA DE MORTE', r['morte'], '<-- o que o jogador sente');
linha('morte sem .sangria', r['morte-sem-sangria'], `delta ${(r['morte'].med - r['morte-sem-sangria'].med).toFixed(2)}`);
linha('morte sem NENHUM DOM', r['morte-sem-dom'], `custo do overlay: ${(r['morte'].med - r['morte-sem-dom'].med).toFixed(2)}`);
linha('morte sem render 3D', r['morte-sem-3d'], `custo do 3D: ${(r['morte'].med - r['morte-sem-3d'].med).toFixed(2)}`);

console.log('');
console.log('=== o grao de filme (feTurbulence): filtro ou camada de mistura? ===');
cabecalho();
const g = await comparar(['menu', 'menu-grao-sem-blend', 'menu-sem-grao'], 5, 45);
linha('menu como esta', g['menu']);
linha('menu, grao sem mix-blend', g['menu-grao-sem-blend'], `delta ${(g['menu'].med - g['menu-grao-sem-blend'].med).toFixed(2)}`);
linha('menu sem grao nenhum', g['menu-sem-grao'], `delta ${(g['menu'].med - g['menu-sem-grao'].med).toFixed(2)}`);

// --------------------------------------------------------------------------
// O caso REAL: ninguem morre em campo vazio. Enche a onda e mede de novo.
// --------------------------------------------------------------------------
const pop = await page.evaluate(() => window.__tf.popular(10));
console.log('');
console.log(`=== CAMPO CHEIO (${pop.vivos} hostis vivos, ${pop.ragdolls} ragdolls) ===`);
cabecalho();
const c = await comparar(['jogando', 'morte', 'morte-sem-dom', 'morte-sem-3d'], 4, 45);
linha('jogando (referencia)', c['jogando']);
linha('TELA DE MORTE', c['morte'], '<-- o relato do usuario');
linha('morte sem NENHUM DOM', c['morte-sem-dom'], `custo do overlay: ${(c['morte'].med - c['morte-sem-dom'].med).toFixed(2)}`);
linha('morte sem render 3D', c['morte-sem-3d'], `custo do 3D: ${(c['morte'].med - c['morte-sem-3d'].med).toFixed(2)}`);

// Censo do que continua vivo com o jogador morto.
const censo = await page.evaluate(() => {
  const ctx = window.__game.ctx;
  ctx.state = 'morto';
  const fx = ctx.fx;
  let vivas = 0;
  for (const [, pool] of Object.entries(fx?.pools ?? {})) vivas += pool?.vivas ?? pool?.ativos ?? 0;
  return {
    estado: ctx.state,
    hudVisivel: ctx.hud?.visivel,
    ragdolls: (ctx.ai?.pool ?? []).filter((e) => e?.ragdoll?.ativo).length,
    corposAtivos: (ctx.ai?.pool ?? []).filter((e) => e?.ativo).length,
    particulasVivas: vivas,
    decais: ctx.fx?.decals?.usados ?? null,
    drawCalls: ctx.renderer.info.render.calls,
    triangulos: ctx.renderer.info.render.triangles,
    etiquetasLigadas: !!ctx.etiquetas?.ligado,
  };
});
console.log('');
console.log('=== censo com o jogador morto ===');
console.log(JSON.stringify(censo, null, 2));

await browser.close();
vite.kill();
