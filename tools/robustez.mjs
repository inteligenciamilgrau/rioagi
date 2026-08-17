/**
 * Prova as duas defesas acrescentadas na revisao de seguranca:
 *
 *  1. Settings._load() sanea o que le do localStorage (tipo e faixa), para que
 *     um valor corrompido nao vire NaN num AudioParam do WebAudio.
 *  2. Killfeed.add() escreve nome por textContent, entao marcacao em nome nao
 *     cria elemento — e a ESTRUTURA do DOM continua a mesma de antes.
 *
 * Nao carrega o jogo: importa os modulos numa pagina em branco servida pelo
 * proprio Vite (via page.route), porque o boot completo leva dezenas de
 * segundos e nao tem relacao nenhuma com o que esta sendo testado aqui.
 *
 *   node tools/robustez.mjs
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = Number(process.env.PORT ?? 5233);
const BASE = `http://127.0.0.1:${PORT}`;

const vite = spawn(process.execPath, [
  'node_modules/vite/bin/vite.js',
  '--config', 'tools/vite.diag.config.js',
  '--host', '127.0.0.1', '--port', String(PORT), '--strictPort',
], { stdio: ['ignore', 'pipe', 'pipe'] });

await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout subindo o vite')), 60000);
  vite.stdout.on('data', (d) => { if (/ready in|Local:/i.test(String(d))) { clearTimeout(t); res(); } });
  vite.stderr.on('data', (d) => process.stderr.write(String(d)));
});

const browser = await chromium.launch({ headless: true, executablePath: process.env.PW_CHROME || undefined });
const page = await browser.newPage();

// Pagina em branco NA MESMA ORIGEM do Vite: sem isso o import dinamico dos
// modulos e barrado por origem cruzada.
await page.route(`${BASE}/__probe.html`, (r) =>
  r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset=utf-8><title>probe</title>' }));

let falhas = 0;
const checa = (nome, ok, detalhe = '') => {
  console.log(`${ok ? '  OK  ' : ' FALHA'}  ${nome}${detalhe ? '   ' + detalhe : ''}`);
  if (!ok) falhas++;
};

/* ------------------------------------------------------------------ */
/* 1) Settings                                                         */
/* ------------------------------------------------------------------ */
// Valores propositalmente destrutivos, do tipo que um localStorage editado a
// mao, uma extensao, ou uma versao antiga do jogo deixaria para tras.
const SUJO = {
  masterVolume: 'alto',        // string onde se espera numero
  sfxVolume: 99,               // fora de faixa
  musicVolume: -5,             // negativo
  fov: null,                   // nulo
  sensitivity: 1e9,            // absurdo
  exposure: 0,                 // zero: escureceria a tela inteira
  invertY: 'sim',              // string onde se espera booleano
  quality: 'ultra-mega',       // preset inexistente
  showFps: 1,                  // numero onde se espera booleano
  __proto__: { poluido: true }, // tentativa de poluicao de prototipo
  chaveInventada: 'xxx',       // chave que nao existe em DEFAULTS
};

await page.goto(`${BASE}/__probe.html`);
const s = await page.evaluate(async ([sujo, base]) => {
  localStorage.setItem('oca:settings:v1', JSON.stringify(sujo));
  const { Settings } = await import(`${base}/src/core/Settings.js`);
  const st = new Settings(null);
  return {
    masterVolume: st.masterVolume, sfxVolume: st.sfxVolume, musicVolume: st.musicVolume,
    fov: st.fov, sensitivity: st.sensitivity, exposure: st.exposure,
    invertY: st.invertY, quality: st.quality, showFps: st.showFps,
    temChaveInventada: 'chaveInventada' in st,
    poluido: ({}).poluido !== undefined,
    todosFinitos: ['masterVolume', 'sfxVolume', 'musicVolume', 'fov', 'sensitivity', 'exposure']
      .every((k) => Number.isFinite(st[k])),
  };
}, [SUJO, BASE]);

console.log('\n=== Settings com localStorage corrompido ===');
checa('nenhum valor numerico virou NaN/Infinity', s.todosFinitos);
checa('masterVolume (string) voltou ao padrao', s.masterVolume === 0.8, `= ${s.masterVolume}`);
checa('sfxVolume 99 foi limitado a 1', s.sfxVolume === 1, `= ${s.sfxVolume}`);
checa('musicVolume -5 foi limitado a 0', s.musicVolume === 0, `= ${s.musicVolume}`);
checa('fov null voltou ao padrao', s.fov === 80, `= ${s.fov}`);
checa('sensitivity 1e9 foi limitada', s.sensitivity <= 0.05, `= ${s.sensitivity}`);
checa('exposure 0 subiu para o minimo', s.exposure >= 0.1, `= ${s.exposure}`);
checa('invertY (string) voltou a booleano', typeof s.invertY === 'boolean', `= ${s.invertY}`);
checa('quality inexistente voltou ao padrao', s.quality === 'alto', `= ${s.quality}`);
checa('showFps (numero) voltou a booleano', typeof s.showFps === 'boolean', `= ${s.showFps}`);
checa('chave inventada NAO entrou', !s.temChaveInventada);
checa('prototipo do Object nao foi poluido', !s.poluido);

/* ------------------------------------------------------------------ */
/* 2) Killfeed                                                         */
/* ------------------------------------------------------------------ */
const k = await page.evaluate(async ([base]) => {
  const { Killfeed } = await import(`${base}/src/ui/Killfeed.js`);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const kf = new Killfeed(host);

  const veneno = '<img src=x onerror="window.__EXECUTOU=1">';
  kf.add(veneno, '<script>window.__EXECUTOU=1<\/script>', { arma: 'fuzil', headshot: true });
  await new Promise((r) => setTimeout(r, 60));

  const linha = host.firstElementChild;
  const filhos = [...linha.children].map((c) => c.tagName.toLowerCase() + '.' + (c.getAttribute('class') || ''));
  return {
    executou: window.__EXECUTOU === 1,
    imgsCriadas: host.querySelectorAll('img').length,
    scriptsCriados: host.querySelectorAll('script').length,
    textoAutor: linha.querySelector('.autor').textContent,
    // a estrutura tem de continuar: span.autor, svg.hs, svg.arma, span.alvo
    estrutura: filhos.join(' | '),
    svgsPreservados: linha.querySelectorAll('svg').length,
  };
}, [BASE]);

console.log('\n=== Killfeed com nome contendo marcacao ===');
checa('nenhum script executou', !k.executou);
checa('nenhum <img> foi criado', k.imgsCriadas === 0, `= ${k.imgsCriadas}`);
checa('nenhum <script> foi criado', k.scriptsCriados === 0, `= ${k.scriptsCriados}`);
checa('o nome aparece como TEXTO literal', k.textoAutor === '<img src=x onerror="window.__EXECUTOU=1">');
checa('os 2 SVG continuam sendo desenhados', k.svgsPreservados === 2, `= ${k.svgsPreservados}`);
checa('estrutura do DOM preservada', /span\.autor \| svg\.hs \| svg\.arma \| span\.alvo/.test(k.estrutura), k.estrutura);

await browser.close();
vite.kill();
console.log(falhas === 0 ? '\n>>> OK: as duas defesas funcionam' : `\n>>> ${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);
