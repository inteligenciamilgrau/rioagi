/* Mede a luneta da sniper: quanto da tela sobra visível dentro da abertura.
 *
 * Método: em vez de "olhar no olho", pintamos um fundo BRANCO puro atrás do HUD,
 * escondemos todo o resto (canvas 3D e demais widgets) e tiramos uma screenshot.
 * Todo pixel que continuar branco absoluto passou pela luneta sem nenhuma
 * atenuação; qualquer outro foi coberto pela máscara ou pelo retículo.
 * A screenshot volta pro browser como data-URL e é contada num canvas 2D — dá
 * um número exato, sem depender de decoder de PNG em Node.
 *
 * Uso: node tools/luneta.mjs [sufixo]     (ex.: node tools/luneta.mjs antes)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const PORT = 5216;
const TAG = process.argv[2] || 'medida';
const TELAS = [
  { w: 1280, h: 720 },
  { w: 1600, h: 900 },
  { w: 1920, h: 1080 },
  // Extremos de proporção: ultrawide 21:9 e uma tela "baixa" 5:4, para provar
  // que a abertura não colapsa nem engole a máscara fora do 16:9.
  { w: 2560, h: 1080, extra: true },
  { w: 1280, h: 1024, extra: true },
];

/* Config de diagnóstico: sem HMR e ignorando `shots/`. Gravar as screenshots
 * dentro do projeto acordava o watcher do Vite e a página recarregava no meio
 * da medição ("Execution context was destroyed"). */
const vite = spawn(process.execPath,
  [ROOT + '/node_modules/vite/bin/vite.js', '--config', ROOT + '/tools/vite.diag.config.js',
    '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r, j) => {
  let o = ''; const h = (d) => { o += d; if (/ready in/.test(o)) r(); };
  vite.stdout.on('data', h); vite.stderr.on('data', h);
  setTimeout(() => j(new Error('timeout vite')), 40000);
});

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});

/** Conta pixels brancos puros da screenshot (feita no modo de medição). */
async function contar(page, buf, w, h) {
  const dataUrl = 'data:image/png;base64,' + buf.toString('base64');
  return page.evaluate(async ({ dataUrl, w, h }) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
    const cv = document.createElement('canvas');
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    let brancos = 0;
    const cy = (cv.height / 2) | 0;
    // Varredura da linha do meio: mede o diâmetro da abertura em pixels.
    let primeiro = -1, ultimo = -1;
    for (let y = 0; y < cv.height; y++) {
      for (let x = 0; x < cv.width; x++) {
        const i = (y * cv.width + x) * 4;
        const puro = d[i] > 250 && d[i + 1] > 250 && d[i + 2] > 250;
        if (puro) brancos++;
        if (y === cy && puro) { if (primeiro < 0) primeiro = x; ultimo = x; }
      }
    }
    const esc = cv.width / w;                      // devicePixelRatio efetivo

    /* Espessura MEDIDA dos traços. Cada corrida escura entre pixels brancos é um
     * traço; é a única forma honesta de checar `non-scaling-stroke`, porque o
     * valor do CSS mente sobre o que sai na tela (o <g> pode declarar uma coisa
     * e os filhos desenharem outra).
     *   linha a  10 px do centro: pega o anel + a escada de mil-dot horizontal;
     *   linha a 200 px do centro: pega o anel + a haste vertical grossa. */
    const varrer = (dy) => {
      const out = [];
      const y = cy - Math.round(dy * esc);
      let dentro = false, corr = 0;
      for (let x = 0; x < cv.width; x++) {
        const i = (y * cv.width + x) * 4;
        const puro = d[i] > 250 && d[i + 1] > 250 && d[i + 2] > 250;
        if (puro) { if (corr && dentro) out.push(+(corr / esc).toFixed(1)); corr = 0; dentro = true; }
        else if (dentro) corr++;
      }
      return out;
    };
    return {
      fracao: brancos / (cv.width * cv.height),
      vao: primeiro < 0 ? 0 : (ultimo - primeiro + 1) / esc,  // ponta a ponta
      traçosEscada: varrer(10),
      traçosHaste: varrer(200),
    };
  }, { dataUrl, w, h });
}

/** Espera o jogo subir E o menu aparecer — o estado estável para mexer no HUD. */
async function aguardarJogo(p) {
  /* Atenção à assinatura: waitForFunction(fn, arg, options). Passar as opções
   * na segunda posição faz o Playwright tratá-las como argumento e cair no
   * timeout padrão de 30 s — que o boot do jogo estoura. */
  await p.waitForFunction(() => window.__game?.ready, null, { timeout: 180000 });
  /* `ready` chega ANTES de `boot:done`, e o menu só aparece 420 ms depois disso.
   * Sem esperar a tela de menu subir, ela reaparece por cima da luneta e
   * estraga a medição. */
  await p.waitForFunction(() => window.__game?.ctx?.menu?.telaAtual === 'menu', null, { timeout: 120000 });
  await p.waitForTimeout(800);
}

/* Aquecimento: na primeira carga o Vite otimiza as dependências e MANDA A PÁGINA
 * RECARREGAR no meio do caminho — isso apagava `window.__game` entre um evaluate
 * e outro. Uma página descartável antes das medições paga esse pedágio. */
{
  const q = await b.newPage({ viewport: { width: 800, height: 600 } });
  await q.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
  await aguardarJogo(q);
  await q.close();
}

const linhas = [];
for (const { w, h, extra } of TELAS) {
  console.log(`--- medindo ${w}x${h} ---`);
  const p = await b.newPage({ viewport: { width: w, height: h } });
  p.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));
  p.on('framenavigated', (f) => { if (f === p.mainFrame()) console.log('  (recarregou)'); });
  await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
  await aguardarJogo(p);

  // Entra em ADS com a sniper (slot 1 = tecla 2).
  const estado = await p.evaluate(async (ANTIGO) => {
    const ctx = window.__game.ctx;
    /* ANTIGO=1 recria a luneta como ela era antes do conserto (abertura 46vh,
     * SVG de 100vh, traços grossos e escalonáveis). Serve para medir o "antes"
     * nas mesmas cinco telas sem precisar reverter os arquivos. */
    if (ANTIGO) {
      const st = document.createElement('style');
      st.textContent = `
        .hud-luneta { --raio: 46vh; }
        .hud-luneta .mascara { background: radial-gradient(circle at 50% 50%,
          rgba(0,0,0,0) 0, rgba(0,0,0,0) calc(46vh - 1px), rgba(0,0,0,.35) 46vh,
          rgba(0,0,0,.92) calc(46vh + 6px), #000 calc(46vh + 22px)); }
        .hud-luneta .reticulo { width: 100vh; height: 100vh; }
        /* Especificidade tem de bater a regra nova (.reticulo circle/path):
         * senão o "antes" herda o traço fino do "depois" e a comparação mente. */
        .hud-luneta .reticulo circle,
        .hud-luneta .reticulo path { vector-effect: none; }
        .hud-luneta .reticulo .aro { stroke: rgba(0,0,0,.85); stroke-width: 2.5; }
        .hud-luneta .reticulo .cruz { stroke-width: 2.2; vector-effect: non-scaling-stroke; }
        .hud-luneta .reticulo .fina { stroke-width: .9; }
        .hud-luneta .reticulo .mil { stroke-width: 1.4; }`;
      document.head.appendChild(st);
      const svg = document.querySelector('.hud-luneta .reticulo');
      svg.innerHTML =
        '<circle class="aro" cx="0" cy="0" r="78"/>' +
        '<path class="cruz" d="M-78 0H-14M14 0H78M0-78V-14M0 14V78"/>' +
        '<path class="fina" d="M-14 0H14M0-14V14"/>' +
        '<g class="mil">' +
        '<path d="M-6 12H6M-6 24H6M-6 36H6M-6 48H6"/>' +
        '<path d="M-6-12H6M-6-24H6M-6-36H6"/>' +
        '<path d="M12-6V6M24-6V6M36-6V6M48-6V6"/>' +
        '<path d="M-12-6V6M-24-6V6M-36-6V6M-48-6V6"/></g>';
    }
    /* Sair do menu de verdade: `hideAll()` sozinho não liga o HUD (ele fica com
     * o atributo `hidden`), e sem HUD não há luneta pra medir. */
    ctx.menu?.mostrar?.(null);
    ctx.state = 'jogando';
    ctx.hud?.reset?.();
    ctx.hud?.setVisible?.(true);
    ctx.bus?.emit?.('game:start', {});
    const ws = ctx.player.weapons;
    const luneta = () => !!document.querySelector('.hud-luneta')?.classList.contains('ativa');
    const rodar = (n = 80) => {
      for (let i = 0; i < n; i++) ctx.player.update(1 / 60);
      ctx.hud.update(1 / 60);
    };

    /* Checagem de ligar/desligar antes de medir: a luneta só pode existir com a
     * sniper E em ADS. */
    ws.switchTo(1); rodar(90);
    const sniperQuadril = luneta();
    ctx.player.forceADS?.(true); rodar();
    const sniperAds = luneta();
    ctx.player.forceADS?.(false); rodar();
    ws.switchTo(0); rodar(90);
    ctx.player.forceADS?.(true); rodar();
    const fuzilAds = luneta();
    ctx.player.forceADS?.(false); rodar();

    // Volta para a sniper em ADS: é esse o estado que vai ser medido.
    ws.switchTo(1); rodar(90);
    ctx.player.forceADS?.(true); rodar();
    window.__game.settle?.(14);
    const svg = document.querySelector('.hud-luneta .reticulo');
    const r = svg?.getBoundingClientRect();
    const esc = r ? r.height / 200 : 0;            // px por unidade do viewBox
    const espessura = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const sw = parseFloat(cs.strokeWidth) || 0;
      return cs.vectorEffect === 'non-scaling-stroke' ? sw : +(sw * esc).toFixed(2);
    };
    return {
      arma: ws.slot.def.name,
      ativa: luneta(),
      sniperQuadril, sniperAds, fuzilAds,
      escala: +esc.toFixed(3),
      aro: espessura('.hud-luneta .aro'),
      cruz: espessura('.hud-luneta .cruz'),
      fina: espessura('.hud-luneta .fina'),
      // `.mil` é um <g>: quem pinta são os <path> filhos, e é neles que
      // `vector-effect` vale. Ler o <g> daria um número que não existe na tela.
      mil: espessura('.hud-luneta .mil path'),
    };
  }, !!process.env.ANTIGO);

  // Screenshot "bonita" (cena real) pra inspeção visual.
  await p.waitForTimeout(900);
  /* A mira comum tem transição de opacidade; ler logo depois de ligar a luneta
   * pegaria o valor no meio do fade. Por isso a leitura acontece aqui. */
  estado.miraOpac = await p.evaluate(() => ({
    mira: +getComputedStyle(document.querySelector('.hud-mira')).opacity,
    ponto: +getComputedStyle(document.querySelector('.hud-ponto')).opacity,
  }));
  await p.screenshot({ path: `${ROOT}/shots/luneta-${TAG}-${w}x${h}.png` });

  // --- modo de medição: fundo branco, só a luneta na frente -----------------
  await p.evaluate(() => {
    const bg = document.createElement('div');
    bg.id = '__medida-bg';
    /* z-index 1: `#ui-root` já vive em 5 e o fundo precisa ficar ATRÁS dele
     * (mesmo z-index + vir depois no DOM cobriria o HUD inteiro). */
    bg.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:1';
    document.body.appendChild(bg);
    document.querySelectorAll('canvas').forEach((c) => { c.style.visibility = 'hidden'; });
    const hud = document.getElementById('hud') || window.__game?.ctx?.hud?.el;
    if (!hud) throw new Error('sem #hud: ' + document.body.innerHTML.slice(0, 200));
    for (const ch of hud.children) {
      if (!ch.classList.contains('hud-luneta')) ch.style.visibility = 'hidden';
    }
    // Qualquer overlay de menu/pausa fora do #hud também sai.
    document.querySelectorAll('#ui-root > *').forEach((n) => {
      if (n.id !== 'hud') n.style.visibility = 'hidden';
    });
  });
  await p.waitForTimeout(120);
  const bufTudo = await p.screenshot({ path: `${ROOT}/shots/luneta-${TAG}-mapa-${w}x${h}.png` });
  const comTudo = await contar(p, bufTudo, w, h);

  // Agora só a máscara (sem retículo): geometria pura da abertura.
  await p.evaluate(() => {
    document.querySelector('.hud-luneta .reticulo').style.display = 'none';
  });
  await p.waitForTimeout(120);
  const bufMasc = await p.screenshot();
  const soMascara = await contar(p, bufMasc, w, h);

  linhas.push({ w, h, extra, estado, comTudo, soMascara });
  await p.close();
}

console.log(`\n=== LUNETA (${TAG}) ===`);
for (const L of linhas) {
  const { w, h, extra, estado, comTudo, soMascara } = L;
  const prop = (w / h).toFixed(2);
  console.log(`${w}x${h} (${prop}:1)${extra ? ' [extra]' : ''}  arma=${estado.arma}  ativa=${estado.ativa}`);
  console.log(`  liga/desliga: sniper+ADS=${estado.sniperAds} | sniper no quadril=${estado.sniperQuadril}` +
    ` | fuzil+ADS=${estado.fuzilAds} | mira normal opac=${estado.miraOpac.mira}` +
    ` | ponto opac=${estado.miraOpac.ponto}`);
  console.log(`  abertura (só máscara): ${(soMascara.fracao * 100).toFixed(1)}% da tela` +
    ` | diâmetro ${soMascara.vao.toFixed(0)}px = ${(soMascara.vao / h * 100).toFixed(0)}% da altura` +
    ` = ${(soMascara.vao / w * 100).toFixed(0)}% da largura`);
  console.log(`  visível de fato (máscara+retículo): ${(comTudo.fracao * 100).toFixed(1)}% da tela` +
    `  (retículo come ${((soMascara.fracao - comTudo.fracao) * 100).toFixed(1)} pontos)`);
  console.log(`  traços declarados (px): aro=${estado.aro} cruz=${estado.cruz} fina=${estado.fina}` +
    ` mil=${estado.mil}  (escala ${estado.escala} px/unidade)`);
  console.log(`  traços MEDIDOS (px) — anel+escada: [${comTudo.traçosEscada.join(', ')}]`);
  console.log(`  traços MEDIDOS (px) — anel+haste:  [${comTudo.traçosHaste.join(', ')}]`);
}

await b.close(); vite.kill();
