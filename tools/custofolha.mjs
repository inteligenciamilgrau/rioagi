/**
 * custofolha.mjs — o preço da correçao, medido.
 *
 *  - tempo de geraçao de material por superficie (o atlas `folha` e novo);
 *  - triangulos e instancias de vegetacao, por tipo;
 *  - FPS medio em 3 poses (dentro do mato, rua aberta, mirante) com o loop real,
 *    descartando os primeiros quadros (compilaçao de shader).
 *
 * Uso: node tools/custofolha.mjs
 */
import { chromium } from 'playwright';

const PORT = process.env.PORT || 5173;

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));
await p.route('**/@vite/client', (r) => r.abort());
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__game?.ready, null, { timeout: 240000 });
await p.waitForTimeout(2500);

const mat = await p.evaluate(() => {
  const s = window.__game.ctx.materials?.stats;
  if (!s) return null;
  const porSup = Object.entries(s.porSuperficie).sort((a, b) => b[1] - a[1]);
  return {
    totalMs: s.totalMs, bancoMs: s.bancoMs, preset: s.preset,
    texturas: s.texturas, mb: Math.round(s.bytesGpu / 1048576),
    top: porSup.slice(0, 6), folha: s.porSuperficie.folha, grama: s.porSuperficie.grama,
  };
});
console.log('--- materiais ---');
console.log(JSON.stringify(mat));

const veg = await p.evaluate(() => {
  const ctx = window.__game.ctx;
  let tri = 0, inst = 0, draws = 0;
  const porTipo = {};
  ctx.world.group.traverse((o) => {
    if (!o.isInstancedMesh || !o.name.startsWith('inst:')) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    if (!ms.some((m) => m && m.name === 'folha')) return;
    const nome = o.name.split(':')[1];
    const t = (o.geometry.attributes.position.count / 3) * o.count;
    tri += t; inst += o.count; draws++;
    porTipo[nome] = porTipo[nome] || { inst: 0, tri: 0, proto: o.geometry.attributes.position.count / 3 };
    porTipo[nome].inst += o.count; porTipo[nome].tri += t;
  });
  return { tri, inst, draws, porTipo, mundo: ctx.world.stats };
});
console.log('\n--- vegetaçao ---');
for (const [k, v] of Object.entries(veg.porTipo)) {
  console.log(`  ${k.padEnd(12)} ${String(v.inst).padStart(5)} inst x ${String(v.proto).padStart(4)} tri = ${(v.tri / 1000).toFixed(0)}k`);
}
console.log(`  TOTAL ${(veg.tri / 1e6).toFixed(2)} M tri, ${veg.inst} instancias, ${veg.draws} draw calls`);
console.log(`  mundo inteiro: ${veg.mundo.triangulos} tri, ${veg.mundo.objetosCena} objetos`);

/**
 * Custo por quadro.
 *
 * NAO se mede isto com FPS por requestAnimationFrame: o loop e travado em 60 Hz,
 * entao qualquer coisa abaixo do limite mede 60 e qualquer coisa acima mede
 * lixo. Aqui chamamos `engine.render()` em rajada e cronometramos — e o tempo
 * real de desenho. Comparar SEMPRE com a mesma camera, senao a medida vira
 * "quanta cena aparece" em vez de "quanto custa a folhagem".
 *
 * As poses sao ancoradas em COORDENADA FIXA, nao em indice de spawn: os spawns
 * podem mudar entre versoes e a comparaçao perderia o sentido.
 */
const poses = [
  ['spawn do paredao', 19.8, 78.8, 0],
  ['mato aberto', -33.3, -71.2, 40],
  ['rua principal', 0, 0, 180],
];
/**
 * METODOLOGIA — por que nao se compara ms/quadro entre duas execuçoes.
 *
 * O rasterizador aqui e o swiftshader (CPU). Com outro agente rodando Playwright
 * na mesma maquina, o mesmo quadro mede 6 ms ou 25 ms conforme a carga. Medir
 * "antes" numa execuçao e "depois" noutra produz numero bonito e mentiroso.
 *
 * Entao a medida e SEMPRE um par A/B dentro do MESMO quadro e da MESMA execuçao:
 * desenha N quadros com a folhagem visivel, N com ela escondida, alternando os
 * blocos, e reporta a DIFERENÇA. A carga da maquina afeta os dois lados igual e
 * some na subtraçao. O que sobra e o custo da folhagem.
 */
console.log('\n--- custo da folhagem (A/B no mesmo quadro: com folha - sem folha) ---');
for (const [nome, x, z, yaw] of poses) {
  const r = await p.evaluate(async ([px, pz, yy]) => {
    const ctx = window.__game.ctx;
    ctx.state = 'pausado';
    const y = ctx.world.heightAt(px, pz);
    ctx.camera.position.set(px, y + 1.68, pz);
    ctx.camera.rotation.set(0, -yy * Math.PI / 180, 0, 'YXZ');
    ctx.camera.updateMatrixWorld(true);
    const ui = document.getElementById('ui-root'); if (ui) ui.style.display = 'none';

    const folhas = [];
    ctx.world.group.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh) return;
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      if (ms.some((m) => m && (m.name === 'folha' || m.name === 'grama'))) folhas.push(o);
    });
    const ver = (v) => { for (const o of folhas) o.visible = v; };

    window.__game.settle(20);                       // aquece: compila shader
    const N = 12, BLOCOS = 5;
    let comMs = 0, semMs = 0;
    for (let k = 0; k < BLOCOS; k++) {
      for (const ligado of [true, false]) {
        ver(ligado);
        window.__game.settle(3);
        const t0 = performance.now();
        window.__game.settle(N);
        const ms = (performance.now() - t0) / N;
        if (ligado) comMs += ms; else semMs += ms;
      }
    }
    ver(true);
    window.__game.settle(2);
    const st = window.__game.stats();
    return {
      com: +(comMs / BLOCOS).toFixed(2), sem: +(semMs / BLOCOS).toFixed(2),
      draws: st.drawCalls, tri: st.triangles, meshes: folhas.length,
    };
  }, [x, z, yaw]);
  const d = (r.com - r.sem).toFixed(2);
  const pct = r.sem > 0 ? ((r.com / r.sem - 1) * 100).toFixed(0) : '?';
  console.log(`  ${nome.padEnd(18)} com ${String(r.com).padStart(6)} ms · sem ${String(r.sem).padStart(6)} ms`
    + `  =>  folhagem custa ${String(d).padStart(6)} ms (+${pct}%)  [${r.draws} draws, ${(r.tri / 1000).toFixed(0)}k tri]`);
}

await b.close();
