/**
 * Custo de desenho do robo, medido de forma que sobreviva a uma maquina
 * ocupada.  Rodar `tools/roboJogo.mjs` duas vezes em momentos diferentes NAO
 * responde a pergunta: neste ambiente a mesma cena vazia mediu 51.9, 62.8, 124
 * e 153 fps em execucoes seguidas, so por causa da carga externa.
 *
 * Aqui as configuracoes sao INTERCALADAS dentro da mesma sessao, em blocos
 * curtos, e o resultado e a MEDIANA por configuracao. Assim a carga de fora
 * afeta as duas igualmente e a diferenca entre elas continua legivel.
 *
 * Compara tres coisas com a MESMA geometria e as MESMAS 9 maquinas:
 *   novo    material de entrega (canais por vertice + dosagem do IBL)
 *   antigo  o mesmo shader SEM as injecoes novas (so rug/met/emi, como era)
 *   vazio   as maquinas escondidas (piso da cena)
 *
 *   node tools/roboFps.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const ROOT = process.cwd(), PORT = 5204;
const vite = spawn(process.execPath, [
  ROOT + '/node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT),
  '--strictPort', '--config', ROOT + '/tools/vite.diag.config.js',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r, j) => {
  let o = ''; const h = (d) => { o += d; if (/ready in/.test(o)) r(); };
  vite.stdout.on('data', h); vite.stderr.on('data', h);
  setTimeout(() => j(new Error('timeout do vite')), 40000);
});

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 1000, height: 720 } });
p.setDefaultTimeout(300000);
p.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__game?.ready, { timeout: 240000 });
await p.waitForTimeout(1500);

const r = await p.evaluate(async () => {
  const ctx = window.__game.ctx;
  const THREE = ctx.ai.pool[0].soldado.malha.material.constructor;
  ctx.ai.spawnAutomatico = false;
  ctx.menu?.hideAll?.(); ctx.hud?.setVisible?.(false); ctx.viewScene.visible = false;
  ctx.state = 'pausado';
  for (const e of ctx.ai.pool) { e.ativo = false; e.soldado.grupo.visible = false; }
  ctx.ai.vivos.length = 0;

  // --- 9 maquinas na frente da camera, paradas e visiveis -----------------
  const T = ctx.camera.position.constructor;
  const jog = ctx.player.position.clone();
  const dir = ctx.camera.getWorldDirection(new T());
  dir.y = 0; dir.normalize();
  const usados = [];
  for (let i = 0; i < 9; i++) {
    const a = ((i - 4) / 9) * 1.6, d = 4.5 + (i % 3) * 2.2;
    const c = Math.cos(a), s = Math.sin(a);
    const dx = dir.x * c - dir.z * s, dz = dir.x * s + dir.z * c;
    const S = ctx.ai.pool[i].soldado;
    S.reviver();
    S.grupo.visible = true;
    S.grupo.position.set(jog.x + dx * d, jog.y, jog.z + dz * d);
    S.grupo.rotation.set(0, Math.atan2(-dx, -dz), 0);
    S.setLocomocao(0, 0, false); S.setMira(jog, 1); S.setPoseArma('mira');
    for (let k = 0; k < 40; k++) S.update(1 / 60);
    usados.push(S);
  }

  // --- material "antigo": mesmo shader, sem as injecoes novas -------------
  const novo = usados[0].malha.material;
  /* O controle tem de nascer LIMPO. Clonar o material de entrega herda
   * `userData` e `defines` por referencia — e como registerMaterial() usa
   * `userData.__ocaCsm` como marca de "ja registrei", o clone entrava na cena
   * com o define USE_CSM ligado e SEM as uniforms de cascata: um shader
   * quebrado, e mais barato. Medido assim, o controle parecia 1.7 ms mais
   * rapido que a entrega, o que era artefato puro. */
  const antigo = new THREE({
    vertexColors: true, roughness: 0.9, metalness: 0.0, envMapIntensity: 1.0,
    name: 'ai_soldado_antigo',
  });
  antigo.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        '#include <common>\nattribute float rugAttr;\nattribute float metAttr;\nattribute float emiAttr;\n'
        + 'varying float vRug;\nvarying float vMet;\nvarying float vEmi;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\n\tvRug = rugAttr;\n\tvMet = metAttr;\n\tvEmi = emiAttr;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nvarying float vRug;\nvarying float vMet;\nvarying float vEmi;')
      .replace('#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n\troughnessFactor = clamp(vRug, 0.05, 1.0);')
      .replace('#include <metalnessmap_fragment>',
        '#include <metalnessmap_fragment>\n\tmetalnessFactor = clamp(vMet, 0.0, 1.0);')
      .replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += vColor.rgb * vEmi;');
  };
  antigo.customProgramCacheKey = () => 'ai_soldado_ANTIGO';
  antigo.userData = {};
  ctx.lighting.registerMaterial(antigo);   // agora ele recebe as uniforms de CSM de verdade

  /* Terceiro braco: EXATAMENTE o material de entrega, menos as duas
   * multiplicacoes do IBL. Isola se os ~0.5 ms sao mesmo essas duas linhas ou
   * se sao artefato do controle "antigo" ser um material construido a mao. */
  const semEnv = new THREE({
    vertexColors: true, roughness: 0.9, metalness: 0.0, envMapIntensity: 1.0,
    name: 'ai_soldado_sem_env',
  });
  semEnv.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        '#include <common>\nattribute float rugAttr;\nattribute float metAttr;\nattribute float emiAttr;\n'
        + 'varying float vRug;\nvarying float vMet;\nvarying float vEmi;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\n\tvRug = rugAttr;\n\tvMet = metAttr;\n\tvEmi = emiAttr;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nvarying float vRug;\nvarying float vMet;\nvarying float vEmi;')
      .replace('#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n\troughnessFactor = clamp(vRug, 0.05, 1.0);')
      .replace('#include <metalnessmap_fragment>',
        '#include <metalnessmap_fragment>\n\tmetalnessFactor = clamp(vMet, 0.0, 1.0);')
      .replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += vColor.rgb * vEmi;');
  };
  semEnv.customProgramCacheKey = () => 'ai_soldado_SEM_ENV';
  semEnv.userData = {};
  ctx.lighting.registerMaterial(semEnv);

  const trocar = (m) => {
    for (const S of usados) { S.malha.material = m; if (S.arma) S.arma.material = m; }
  };
  const ver = (v) => { for (const S of usados) S.grupo.visible = v; };

  // compila os dois antes de medir (senao o primeiro bloco paga o hitch)
  trocar(antigo); window.__game.settle(8);
  trocar(semEnv); window.__game.settle(8);
  trocar(novo); window.__game.settle(8);

  const bloco = (n) => {
    window.__game.settle(4);
    const t0 = performance.now();
    window.__game.settle(n);
    return (performance.now() - t0) / n;
  };

  /* Rodizio de posicoes. Em ABBA o braco 'novo' caia sempre colado ao bloco
   * com as maquinas ESCONDIDAS, e pagava sozinho a transicao (historico de TAA
   * invalidado, sombras dos casters que reaparecem). Isso valia ~0.4 ms e era
   * lido como custo do shader. Aqui cada braco passa por cada posicao o mesmo
   * numero de vezes, e a medida do 'vazio' sai de um laco separado. */
  const bracos = [['novo', novo], ['semEnv', semEnv], ['antigo', antigo]];
  const amostras = { novo: [], semEnv: [], antigo: [], vazio: [] };
  ver(true);
  for (let rodada = 0; rodada < 12; rodada++) {
    const base = rodada % 2 ? [...bracos].reverse() : bracos;
    for (let i = 0; i < 3; i++) {
      const [nome, mat] = base[(i + rodada) % 3];
      trocar(mat); amostras[nome].push(bloco(24));
    }
  }
  trocar(novo);
  ver(false);
  for (let i = 0; i < 6; i++) amostras.vazio.push(bloco(24));
  ver(true);

  const mediana = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  const info = ctx.renderer.info.render;
  return {
    novo: mediana(amostras.novo), semEnv: mediana(amostras.semEnv), antigo: mediana(amostras.antigo), vazio: mediana(amostras.vazio),
    brutos: amostras,
    tris: info.triangles, draws: info.calls,
    trisRobo: usados.reduce((s, S) => s + S.triangulos, 0),
  };
});

const f = (ms) => `${(1000 / ms).toFixed(1).padStart(6)} fps · ${ms.toFixed(2).padStart(6)} ms`;
console.log('\n  9 maquinas, mesma cena, blocos intercalados (mediana de 9 rodadas de 24 quadros)');
console.log('  ------------------------------------------------------------------');
console.log('  material de entrega :', f(r.novo));
console.log('  entrega sem os 2 mul:', f(r.semEnv));
console.log('  shader antigo       :', f(r.antigo));
console.log('  maquinas escondidas :', f(r.vazio));
console.log(`\n  custo de desenhar as 9 maquinas: entrega ${(r.novo - r.vazio).toFixed(2)} ms`
  + ` · antigo ${(r.antigo - r.vazio).toFixed(2)} ms`
  + `  =>  diferenca ${((r.novo - r.antigo)).toFixed(2)} ms/quadro`);
console.log(`  triangulos das 9 maquinas: ${r.trisRobo} · cena: ${r.tris} tris em ${r.draws} draws`);
console.log('  brutos novo  :', r.brutos.novo.map((v) => v.toFixed(1)).join(' '));
console.log('  brutos antigo:', r.brutos.antigo.map((v) => v.toFixed(1)).join(' '));

await b.close();
vite.kill();
