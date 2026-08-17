/**
 * ormprobe.mjs — audita os botoes de PBR que *parecem* estar ligados.
 *
 * Responde tres perguntas que so se respondem medindo:
 *
 * 1. **As superficies estao metalicas sem querer?** Le o canal B do ORM (que o
 *    three usa como metalness, convencao glTF). Chao e asfalto sao dieletricos:
 *    qualquer coisa acima de ~0 ali apaga a difusa e faz a superficie virar so
 *    reflexo do ceu. Medido em 17/08: terra/asfalto/calcada/grama = 0,000.
 *
 * 2. **`envMapIntensity` faz alguma coisa?** Nao — nao enquanto o material nao
 *    tiver `envMap` proprio. `WebGLRenderer.setProgram` sobrescreve o uniform
 *    com `scene.environmentIntensity` a cada quadro, para todo objeto:
 *
 *      three@0.180.0, build/three.module.js:17341
 *      if ( material.isMeshStandardMaterial && material.envMap === null
 *           && scene.environment !== null )
 *          m_uniforms.envMapIntensity.value = scene.environmentIntensity;
 *
 *    Ver `MaterialLibrary.aplicarIBL()` para o caminho que torna o valor efetivo.
 *
 * 3. **O teste por hash de imagem vale?** Nao, e por isso ele imprime um
 *    CONTROLE antes: dois renders identicos do jogo dao hashes diferentes (ceu
 *    e nuvens continuam animando). Sem esse controle o teste "mudou a imagem?"
 *    da falso positivo — foi o que aconteceu na primeira medicao, e foi o
 *    controle que pegou o erro. Se o controle acusar instabilidade, ignore o
 *    veredito do envMapIntensity e confie na fonte do three, citada acima.
 *
 * Servidor: espera vite em PORT (padrao 5199), de preferencia com
 *           --config tools/vite.diag.config.js.
 *
 * Uso: node tools/ormprobe.mjs
 */
import { chromium } from 'playwright';
const PORT = process.env.PORT || 5199;
const b = await chromium.launch({headless:true,args:['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio']});
const p = await b.newPage({viewport:{width:900,height:600}});
p.on('pageerror',e=>console.log('PAGEERR:',e.message.split('\n')[0]));
await p.route('**/@vite/client', r=>r.abort());
await p.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.__game?.ready,null,{timeout:300000});
await p.waitForTimeout(1500);

const r = await p.evaluate(() => {
  const ctx = window.__game.ctx, lib = ctx.materials;
  const out = { metalness: {}, escalares: {}, envInerte: null };
  for (const n of ['terra','asfalto','calcada_portuguesa','grama','telha_fibrocimento','metal_ondulado']) {
    const m = lib.get(n); const d = m?.metalnessMap?.image?.data;
    if (d) {
      let B = 0, max = 0; const c = d.length/4;
      for (let i = 0; i < d.length; i += 4) { B += d[i+2]; if (d[i+2] > max) max = d[i+2]; }
      out.metalness[n] = { medio: +(B/c/255).toFixed(4), maximo: +(max/255).toFixed(3) };
    }
    out.escalares[n] = { metalness: m.metalness, roughness: m.roughness,
      envMapIntensity: m.envMapIntensity, temEnvMapProprio: !!m.envMap };
  }
  // O material do terreno (clone com shader de mistura)
  const t = ctx.world._matTerreno;
  if (t) out.terreno = { metalness: t.metalness, roughness: t.roughness,
    envMapIntensity: t.envMapIntensity, temEnvMapProprio: !!t.envMap, vertexColors: t.vertexColors };
  out.cena = { environmentIntensity: ctx.scene.environmentIntensity, temEnvironment: !!ctx.scene.environment };
  return out;
});
console.log('=== METALNESS no canal B do ORM (0 = dieletrico correto) ===');
for (const [n,v] of Object.entries(r.metalness)) console.log('  '+n.padEnd(22)+'medio '+String(v.medio).padStart(7)+'   max '+String(v.maximo).padStart(6));
console.log('\n=== ESCALARES do material ===');
for (const [n,v] of Object.entries(r.escalares)) console.log('  '+n.padEnd(22)+`met=${v.metalness} rug=${v.roughness} envI=${v.envMapIntensity} envMapProprio=${v.temEnvMapProprio}`);
console.log('\n  terreno(clone):', JSON.stringify(r.terreno));
console.log('  cena:', JSON.stringify(r.cena));

// --- envMapIntensity e inerte? medicao direta ---
const medir = async () => {
  const px = await p.evaluate(() => {
    const ctx = window.__game.ctx;
    window.__game.settle(8);
    const c = ctx.renderer.domElement;
    return [c.width, c.height];
  });
  const buf = await p.screenshot({ clip: { x: 300, y: 200, width: 300, height: 250 } });
  let s = 0; for (let i = 0; i < buf.length; i++) s = (s * 31 + buf[i]) >>> 0;
  return { bytes: buf.length, hash: s };
};
await p.evaluate(() => {
  const ctx = window.__game.ctx;
  const pts = ctx.world.getSpawnPoints();
  window.__game.poseAt(0, 40, -30, { hideViewmodel: true });
  const ui = document.getElementById('ui-root'); if (ui) ui.style.display='none';
  ctx.hud?.setVisible?.(false); ctx.menu?.hideAll?.();
});
const ctrl1 = await medir();
const ctrl2 = await medir();
console.log('\n  CONTROLE (dois renders identicos):', ctrl1.hash, ctrl2.hash,
  ctrl1.hash === ctrl2.hash ? 'estavel' : 'NAO DETERMINISTICO -> teste por hash e invalido');
const a = ctrl2;
await p.evaluate(() => {
  const lib = window.__game.ctx.materials;
  window.__bk = [];
  for (const n of lib.nomes()) { const m = lib.get(n); window.__bk.push([m, m.envMapIntensity]); m.envMapIntensity = 0; m.needsUpdate = true; }
  window.__game.ctx.world._matTerreno.envMapIntensity = 0;
});
const c0 = await medir();
await p.evaluate(() => { for (const [m,v] of window.__bk) { m.envMapIntensity = v; m.needsUpdate = true; } });
console.log('\n=== envMapIntensity = 0 em TODOS os materiais muda a imagem? ===');
console.log('  hash com envI original :', a.hash);
console.log('  hash com envI = 0      :', c0.hash);
console.log('  VEREDITO:', a.hash === c0.hash ? 'IDENTICO -> envMapIntensity e INERTE (confirmado)' : 'mudou -> envMapIntensity tem efeito');
await b.close();
