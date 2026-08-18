/**
 * portashot.mjs — capturas do conserto de "nao da para sair".
 *
 *   1. porta-fechada.png  — porta de casa, fechada, com a DICA na tela
 *   2. porta-aberta.png   — a mesma porta depois do KeyF
 *   3. porta-dentro.png   — de dentro da casa, olhando a porta aberta e a rua
 *   4. descida-antes.png / descida-depois.png — telhado que so tinha salto
 *
 * Duas armadilhas do harness, ja pagas:
 *  · `page.waitForFunction(fn, {timeout})` IGNORA o timeout — a assinatura e
 *    `(fn, arg, options)`.
 *  · a primeira carga do Vite otimiza dependencia e RECARREGA a pagina no meio;
 *    por isso ha uma pagina de aquecimento descartada.
 *  · gravar em `shots/` acorda o watcher — usamos `tools/vite.diag.config.js`,
 *    que ignora essa pasta.
 *
 *   node tools/portashot.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 5239);

const vite = spawn(process.execPath, [
  ROOT + '/node_modules/vite/bin/vite.js', '--config', ROOT + '/tools/vite.diag.config.js',
  '--host', '127.0.0.1', '--port', String(PORT), '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r, j) => {
  let o = ''; const h = (d) => { o += d; if (/ready in/.test(o)) r(); };
  vite.stdout.on('data', h); vite.stderr.on('data', h);
  setTimeout(() => j(new Error('timeout vite')), 60000);
});

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});

async function aguardar(pg) {
  await pg.waitForFunction(() => window.__game?.ready, null, { timeout: 300000 });
  await pg.waitForFunction(() => window.__game?.ctx?.menu?.telaAtual === 'menu', null, { timeout: 180000 });
  await pg.waitForTimeout(700);
}

/* Aquecimento: a primeira carga recarrega sozinha e leva `window.__game` junto. */
{
  const q = await b.newPage({ viewport: { width: 800, height: 600 } });
  await q.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
  await aguardar(q);
  await q.close();
}

const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await aguardar(p);

/** Tira o menu da frente e liga o HUD — o caminho que funciona (ver NOTES). */
await p.evaluate(() => {
  const ctx = window.__game.ctx;
  ctx.menu?.mostrar?.(null);
  ctx.state = 'jogando';
  ctx.hud?.reset?.();
  ctx.hud?.setVisible?.(true);
});
await p.waitForTimeout(300);

/**
 * Poe o jogador de pe olhando para um alvo, e roda o `update` do Player para o
 * jogo inteiro (mira, dica de acao, HUD) ficar coerente com a pose.
 */
async function posar(olho, alvo, quadros = 40) {
  return p.evaluate(({ olho, alvo, quadros }) => {
    const ctx = window.__game.ctx;
    const pl = ctx.player;
    /* Os pes vao no CHAO daquele (x,z), medido com raio.
     * Teleportar para `olho.y - 1.68` deixava o jogador no ar e ele caia durante
     * os quadros simulados: a foto saia de outro lugar, e a dica de acao (que
     * depende da distancia ate a porta) sumia. */
    /* O raio parte da propria altura do olho, e nao de 2,5 m acima: comecando
     * acima do telhado ele acha a LAJE e a foto de dentro da casa vira foto em
     * cima dela. */
    const V = ctx.world.group.position.constructor;
    const h = ctx.world.collision.raycast(
      new V(olho[0], olho[1] + 0.15, olho[2]), new V(0, -1, 0), 8);
    const pesY = h.hit ? h.point.y + 0.02 : olho[1] - 1.68;
    pl.movement.teleport(olho[0], pesY, olho[2]);
    pl.movement.velocity.set(0, 0, 0);
    const dx = alvo[0] - olho[0], dy = alvo[1] - olho[1], dz = alvo[2] - olho[2];
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(dy, Math.hypot(dx, dz));
    pl.rig.reset(yaw, pitch);
    for (let i = 0; i < quadros; i++) {
      pl.update(1 / 60);
      ctx.world.update(1 / 60, 0);
      ctx.hud.update(1 / 60);
    }
    window.__game.settle(12);
    return {
      pos: [+pl.position.x.toFixed(2), +pl.position.y.toFixed(2), +pl.position.z.toFixed(2)],
      dica: document.querySelector('.hud-acao')?.className,
      texto: document.querySelector('.hud-acao .rot')?.textContent,
    };
  }, { olho, alvo, quadros });
}

/* ---------------------------------------------------------------- porta */
const cena = await p.evaluate(() => {
  const w = window.__game.ctx.world;
  /* Escolhe a porta com mais espaco livre na frente: e a que rende foto legivel
   * (beco de 1,3 m enquadra parede, nao porta). */
  let melhor = null, melhorD = -1;
  for (const q of w.portas.lista) {
    const cx = q.eixo.x + Math.cos(q.yawBase) * q.w * 0.5;
    const cz = q.eixo.z - Math.sin(q.yawBase) * q.w * 0.5;
    const o = { x: cx + q.nx * 0.2, y: q.eixo.y + 1.5, z: cz + q.nz * 0.2 };
    const V = w.group.position.constructor;
    const h = w.collision.raycast(new V(o.x, o.y, o.z), new V(q.nx, 0, q.nz), 12);
    const d = h.hit ? h.distance : 12;
    if (d > melhorD) { melhorD = d; melhor = { q, cx, cz, d }; }
  }
  if (!melhor) return null;
  const { q, cx, cz, d } = melhor;
  /* 1,55 m da folha: dentro do alcance de 2,1 m da acao, com a porta inteira
   * no enquadramento. Mais longe a dica nao acende — e ela e metade da foto. */
  const rec = Math.min(1.75, Math.max(1.2, d - 0.5));
  return {
    livre: +d.toFixed(2),
    fora: [cx + q.nx * rec, q.eixo.y + 1.68, cz + q.nz * rec],
    dentro: [cx - q.nx * 1.5, q.eixo.y + 1.68, cz - q.nz * 1.5],
    alvo: [cx, q.eixo.y + 1.05, cz],
    casa: [+q.casa.x.toFixed(1), +q.casa.z.toFixed(1)],
  };
});
console.log('porta escolhida:', JSON.stringify(cena));

if (cena) {
  // 1) fechada, com a dica na tela
  let r = await posar(cena.fora, cena.alvo);
  console.log('  fechada:', JSON.stringify(r));
  await p.screenshot({ path: `${ROOT}/shots/porta-fechada.png` });

  // 2) aberta (mesma pose, mesma camera — a unica coisa que muda e a folha)
  await p.evaluate(() => {
    const ctx = window.__game.ctx;
    const pl = ctx.player;
    ctx.world.portas.acionar(pl._acaoAlvo);
    for (let i = 0; i < 60; i++) { ctx.world.update(1 / 60, 0); pl.update(1 / 60); ctx.hud.update(1 / 60); }
    window.__game.settle(12);
  });
  await p.waitForTimeout(200);
  await p.screenshot({ path: `${ROOT}/shots/porta-aberta.png` });

  // 3) de dentro para fora
  r = await posar(cena.dentro, cena.alvo);
  console.log('  de dentro:', JSON.stringify(r));
  await p.screenshot({ path: `${ROOT}/shots/porta-dentro.png` });
}

/* --------------------------------------------------------------- descida */
const tel = await p.evaluate(() => {
  const w = window.__game.ctx.world;
  /* Casas que GANHARAM degraus de fuga sao etiquetadas por `degrausDeFuga`.
   * Escolhemos a de maior desnivel com pelo menos dois degraus: e onde a
   * escadinha se le como escadinha, e nao como uma laje solta. */
  let melhor = null;
  for (const c of w.favela.casas) {
    if (!c.degrausFuga || c.degrausFuga.length < 2) continue;
    // longe da borda do mapa: no limite a casa aparece contra a "saia" do
    // terreno e o fundo vira neblina, o que nao mostra nada
    if (Math.hypot(c.x, c.z) > 58) continue;
    const alto = c.degrausFuga[c.degrausFuga.length - 1];
    const baixo = c.degrausFuga[0];
    const salto = c.telhadoY - baixo.y;
    if (!melhor || salto > melhor.salto) {
      // camera afastada na perpendicular da parede, na altura do degrau do meio
      const dx = alto.x - c.x, dz = alto.z - c.z;
      const l = Math.hypot(dx, dz) || 1;
      melhor = {
        salto: +salto.toFixed(2),
        casa: [+c.x.toFixed(1), +c.z.toFixed(1)],
        n: c.degrausFuga.length,
        telhadoY: +c.telhadoY.toFixed(2),
        degraus: c.degrausFuga.map((d) => [+d.x.toFixed(1), +d.y.toFixed(2), +d.z.toFixed(1)]),
        /* Vista de fora: ALTA e recuada, olhando a fachada de cima para baixo.
         * Na altura dos degraus a camera cai dentro da casa vizinha — a favela e
         * colada, e um beco de 1,3 m nao tem de onde fotografar de frente. */
        olho: [c.x + (dx / l) * 7.5, alto.y + 7.5, c.z + (dz / l) * 7.5],
        alvo: [(alto.x + baixo.x) * 0.5, (alto.y + baixo.y) * 0.5, (alto.z + baixo.z) * 0.5],
        /* Segunda tomada: de cima da laje, na BEIRADA, olhando para baixo.
         * E a pergunta do jogador — "da para descer daqui?" — enquadrada. */
        deCima: [c.x + (dx / l) * (l - 0.9), c.telhadoY + 1.68, c.z + (dz / l) * (l - 0.9)],
        alvoCima: [alto.x, alto.y - 0.6, alto.z],
      };
    }
  }
  return melhor;
});
console.log('descida escolhida:', JSON.stringify(tel));

if (tel) {
  await p.evaluate(({ olho, alvo }) => {
    window.__game.poseAerea(olho, alvo, { hideViewmodel: true });
    window.__game.settle(16);
  }, tel);
  await p.waitForTimeout(200);
  await p.screenshot({ path: `${ROOT}/shots/descida-telhados.png` });

  // 1) da beirada da laje, olhando o primeiro degrau
  const rc = await posar(tel.deCima, tel.alvoCima, 30);
  console.log('  da laje:', JSON.stringify(rc));
  await p.screenshot({ path: `${ROOT}/shots/descida-da-laje.png` });

  // 2) EM CIMA de um degrau do meio, olhando o proximo — o passo seguinte da
  //    descida, que e onde se ve que a escadinha continua
  const meio = tel.degraus[Math.max(0, tel.degraus.length - 3)];
  const abaixo = tel.degraus[Math.max(0, tel.degraus.length - 4)];
  const rd = await posar([meio[0], meio[1] + 1.68, meio[2]],
    [abaixo[0], abaixo[1] + 0.1, abaixo[2]], 24);
  console.log('  no degrau:', JSON.stringify(rd));
  await p.screenshot({ path: `${ROOT}/shots/descida-no-degrau.png` });
}

await b.close();
vite.kill();
console.log('\ncapturas em shots/: porta-fechada.png, porta-aberta.png, porta-dentro.png, descida-degraus.png');
