/**
 * chaodiag.mjs — diagnostico e prova visual do CHAO DE TERRENO.
 *
 * Faz quatro coisas numa passada so, com o mesmo boot:
 *   1. mede o custo de MaterialLibrary.init() e o custo por superficie
 *   2. audita o contrato de UV do terreno (quantos metros um tile cobre de fato,
 *      texels por metro, cor de vertice) — e o numero que explica o defeito
 *   3. fotografa o chao a TRES distancias: pe (1,5 m), media (10 m), pano (40 m)
 *   4. fotografa uma vista com chao + folhagem + calcada portuguesa junta
 *
 * Uso:  node tools/chaodiag.mjs <rotulo>      (ex.: antes / depois)
 * Servidor: espera vite em PORT (padrao 5199), de preferencia com
 *           --config tools/vite.diag.config.js para o watcher nao recarregar.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

const ROOT = process.cwd();
const PORT = process.env.PORT || 5199;
const ROTULO = process.argv[2] || 'antes';
mkdirSync(ROOT + '/shots', { recursive: true });

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));
await p.route('**/@vite/client', (r) => r.abort());
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__game?.ready, null, { timeout: 300000 });
await p.waitForTimeout(2500);

// ---------------------------------------------------------------- 1 e 2
const diag = await p.evaluate(() => {
  const ctx = window.__game.ctx;
  const lib = ctx.materials;
  const st = lib?.stats ?? {};

  // --- terreno: qual material, qual UV, quantos metros por tile de fato ---
  let terr = null;
  ctx.world.group.traverse((o) => {
    if (terr || !o.isMesh || !o.name.startsWith('terreno:') || o.name.includes('saia')) return;
    const m = o.material;
    const uv = o.geometry.attributes.uv, pos = o.geometry.attributes.position;
    // metros de mundo percorridos por 1 unidade de UV (mede no proprio buffer)
    let du = 0, dx = 0;
    for (let i = 1; i < Math.min(400, uv.count); i++) {
      du += Math.abs(uv.getX(i) - uv.getX(i - 1));
      dx += Math.abs(pos.getX(i) - pos.getX(i - 1));
    }
    const metrosPorUV = du > 0 ? dx / du : 0;
    const rep = m.map?.repeat;
    const res = m.map?.image?.width ?? 0;
    // amostra de cor de vertice
    const col = o.geometry.attributes.color;
    const amostras = [];
    for (let i = 0; i < 6; i++) {
      const k = ((i * 977) % col.count);
      amostras.push([+col.getX(k).toFixed(3), +col.getY(k).toFixed(3), +col.getZ(k).toFixed(3)]);
    }
    terr = {
      nomeMaterial: m.name,
      superficie: m.userData?.nome ?? '?',
      metrosDeclarados: m.userData?.metros ?? null,
      repeat: rep ? [rep.x, rep.y] : null,
      metrosPorUV: +metrosPorUV.toFixed(3),
      resolucaoAlbedo: res,
      vertexColors: m.vertexColors,
      corMaterial: [+m.color.r.toFixed(3), +m.color.g.toFixed(3), +m.color.b.toFixed(3)],
      amostrasCorVertice: amostras,
    };
  });
  if (terr) {
    // metros que um TILE inteiro cobre no mundo = metrosPorUV / repeat
    terr.metrosPorTileReal = +(terr.metrosPorUV / (terr.repeat?.[0] || 1)).toFixed(3);
    terr.texelsPorMetro = Math.round(terr.resolucaoAlbedo / terr.metrosPorTileReal);
  }

  // --- quem consome cada material natural ---
  const uso = {};
  ctx.scene.traverse((o) => {
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of ms) {
      if (!m) continue;
      const n = lib?.getNomeSuperficie?.(m) ?? m.name;
      if (!['terra', 'grama', 'folha', 'calcada_portuguesa'].includes(n)) continue;
      (uso[n] ??= []).push(o.name || o.type);
    }
  });
  for (const k of Object.keys(uso)) uso[k] = [...new Set(uso[k])].slice(0, 8);

  // --- media de cor do albedo de terra/grama (o que a textura entrega) ---
  const corDe = (nome) => {
    const d = lib?.get?.(nome)?.map?.image?.data;
    if (!d) return null;
    let R = 0, G = 0, B = 0; const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) { R += d[i]; G += d[i + 1]; B += d[i + 2]; }
    return { r: Math.round(R / n), g: Math.round(G / n), b: Math.round(B / n) };
  };

  return {
    boot: {
      totalMs: st.totalMs, bancoMs: st.bancoMs, preset: st.preset,
      texturas: st.texturas, mbGpu: +(st.bytesGpu / 1048576).toFixed(1),
      porSuperficie: st.porSuperficie ?? {},
    },
    terreno: terr,
    uso,
    albedoMedio: { terra: corDe('terra'), grama: corDe('grama') },
  };
});

console.log(`\n=== BOOT (${diag.boot.preset}) ===`);
console.log(`MaterialLibrary.init(): ${diag.boot.totalMs} ms  (banco ${diag.boot.bancoMs} ms)`);
console.log(`texturas ${diag.boot.texturas}, ~${diag.boot.mbGpu} MB VRAM`);
const ps = Object.entries(diag.boot.porSuperficie).sort((a, b) => b[1] - a[1]);
console.log('mais caras: ' + ps.slice(0, 6).map(([n, v]) => `${n} ${v}ms`).join(', '));
console.log(`  terra=${diag.boot.porSuperficie.terra}ms  grama=${diag.boot.porSuperficie.grama}ms  folha=${diag.boot.porSuperficie.folha}ms`);

console.log(`\n=== TERRENO ===`);
console.log(JSON.stringify(diag.terreno, null, 2));
console.log(`\n=== QUEM USA ===`);
console.log(JSON.stringify(diag.uso, null, 2));
console.log(`\n=== ALBEDO MEDIO ===`, JSON.stringify(diag.albedoMedio));

writeFileSync(`${ROOT}/shots/chaodiag-${ROTULO}.json`, JSON.stringify(diag, null, 2));

// ---------------------------------------------------------------- 3 e 4
// Acha um ponto de terreno aberto: raio pra baixo bate em 'terra' e a
// vizinhanca tambem. Deterministico (mundo tem seed fixa).
const pontos = await p.evaluate(() => {
  const ctx = window.__game.ctx;
  const col = ctx.world.collision;
  const baixo = { x: 0, y: -1, z: 0 };
  const solo = (x, z) => col.raycast({ x, y: 90, z }, baixo, 200);

  /** Melhor ponto aberto de uma superficie: vizinhanca continua e plana. */
  const acharCampo = (sup, passo = 4) => {
    const cands = [];
    for (let x = -80; x <= 80; x += passo) {
      for (let z = -80; z <= 80; z += passo) {
        const h = solo(x, z);
        if (!h.hit || h.surface !== sup || h.normal.y < 0.86) continue;
        let bons = 0, n = 0, dy = 0;
        for (let a = 0; a < 12; a++) {
          const ang = (a / 12) * Math.PI * 2;
          for (const r of [3, 7, 12, 20]) {
            const q = solo(x + Math.sin(ang) * r, z + Math.cos(ang) * r);
            n++;
            if (q.hit && q.surface === sup) { bons++; dy += Math.abs(q.point.y - h.point.y); }
          }
        }
        cands.push({ x, z, y: h.point.y, frac: bons / n, plano: 1 - Math.min(1, dy / (n * 6)) });
      }
    }
    cands.sort((a, b) => (b.frac * 2 + b.plano) - (a.frac * 2 + a.plano));
    return cands[0] ?? null;
  };

  const campo = acharCampo('terra');
  const rua = acharCampo('asfalto', 3);

  // Camera panoramica: precisa ver MUITO chao, entao sobe e procura um ponto
  // com linha de visada limpa ate o alvo (a versao anterior nascia dentro de casa).
  const panoDe = (alvo, dist, alt) => {
    let melhor = null;
    for (let k = 0; k < 48; k++) {
      const ang = (k / 48) * Math.PI * 2;
      const cx = alvo.x + Math.sin(ang) * dist, cz = alvo.z + Math.cos(ang) * dist;
      const g = solo(cx, cz);
      const cy = Math.max(alvo.y + alt, (g.hit ? g.point.y : alvo.y) + 3.5);
      const dx = alvo.x - cx, dy = alvo.y - cy, dz = alvo.z - cz;
      const L = Math.hypot(dx, dy, dz);
      const v = col.raycast({ x: cx, y: cy, z: cz }, { x: dx / L, y: dy / L, z: dz / L }, L * 0.95);
      const livre = (!v.hit || v.distance > L * 0.9) ? 1 : 0;
      // conta quanto chao daquela superficie cai no caminho (quer muito)
      let vista = 0;
      for (let t = 0.25; t < 1; t += 0.08) {
        const q = solo(cx + dx * t, cz + dz * t);
        if (q.hit && q.surface === alvo.sup) vista++;
      }
      const pts = livre * 100 + vista;
      if (!melhor || pts > melhor.pts) melhor = { pts, cx, cy, cz, livre };
    }
    return melhor;
  };

  // ponto com chao + folhagem + calcada portuguesa no mesmo enquadramento
  const alvosCal = [];
  ctx.scene.traverse((o) => {
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    if (!ms.some((m) => m && ctx.materials?.getNomeSuperficie?.(m) === 'calcada_portuguesa')) return;
    o.geometry?.computeBoundingBox?.();
    const bb = o.geometry?.boundingBox; if (!bb) return;
    alvosCal.push({ x: (bb.min.x + bb.max.x) / 2, y: (bb.min.y + bb.max.y) / 2, z: (bb.min.z + bb.max.z) / 2 });
  });

  return {
    campo, rua, calcada: alvosCal.slice(0, 8),
    pano: campo ? panoDe({ ...campo, sup: 'terra' }, 34, 11) : null,
    panoRua: rua ? panoDe({ ...rua, sup: 'asfalto' }, 26, 8) : null,
  };
});
console.log('\n=== PONTO DE CHAO  ===', JSON.stringify(pontos.campo));
console.log('=== PONTO DE RUA   ===', JSON.stringify(pontos.rua));
console.log('=== CAM PANORAMICA ===', JSON.stringify(pontos.pano));

const tiros = [];
const foto = async (nome, fn, legenda) => {
  await p.evaluate(fn);
  await p.waitForTimeout(350);
  const arq = `${ROOT}/shots/_cd-${ROTULO}-${nome}.png`;
  await p.screenshot({ path: arq });
  tiros.push({ nome, arq, legenda });
  console.log(`  ${legenda}`);
};

const esconderUI = () => {
  const ctx = window.__game.ctx;
  ctx.menu?.hideAll?.(); ctx.hud?.setVisible?.(false);
  const ui = document.getElementById('ui-root'); if (ui) ui.style.display = 'none';
};

// 1,5 m: olho a 1,68 m olhando pro proprio pe
await foto('pe', `(() => {
  const c = ${JSON.stringify(pontos.campo)};
  const ctx = window.__game.ctx;
  ctx.state = 'pausado';
  ctx.camera.position.set(c.x, c.y + 1.68, c.z);
  ctx.camera.up.set(0,1,0);
  ctx.camera.rotation.set(-48 * Math.PI/180, 25 * Math.PI/180, 0, 'YXZ');
  ctx.camera.updateMatrixWorld(true);
  ctx.viewScene.visible = false;
  (${esconderUI.toString()})();
  window.__game.settle(20);
})()`, 'chao ao pe do jogador (~1,5 m)');

// 10 m: chao a media distancia, o teste de tiling
await foto('media', `(() => {
  const c = ${JSON.stringify(pontos.campo)};
  const ctx = window.__game.ctx;
  ctx.state = 'pausado';
  ctx.camera.position.set(c.x, c.y + 1.68, c.z);
  ctx.camera.up.set(0,1,0);
  ctx.camera.rotation.set(-20 * Math.PI/180, 25 * Math.PI/180, 0, 'YXZ');
  ctx.camera.updateMatrixWorld(true);
  ctx.viewScene.visible = false;
  (${esconderUI.toString()})();
  window.__game.settle(20);
})()`, 'chao a media distancia (~10 m)');

// 40 m: panoramica de encosta, onde o ladrilho aparece se aparecer
await foto('pano', `(() => {
  const c = ${JSON.stringify(pontos.campo)}, k = ${JSON.stringify(pontos.pano)};
  const ctx = window.__game.ctx;
  ctx.state = 'pausado';
  ctx.camera.position.set(k.cx, k.cy, k.cz);
  ctx.camera.up.set(0,1,0);
  ctx.camera.lookAt(c.x, c.y, c.z);
  ctx.camera.updateMatrixWorld(true);
  ctx.viewScene.visible = false;
  (${esconderUI.toString()})();
  window.__game.settle(20);
})()`, 'panoramica de chao (~40 m)');

// --- RUA: o asfalto tem que ler como asfalto, nao como lamina d'agua ---
if (pontos.rua) {
  await foto('rua-pe', `(() => {
    const c = ${JSON.stringify(pontos.rua)};
    const ctx = window.__game.ctx;
    ctx.state = 'pausado';
    ctx.camera.position.set(c.x, c.y + 1.68, c.z);
    ctx.camera.up.set(0,1,0);
    ctx.camera.rotation.set(-46 * Math.PI/180, 40 * Math.PI/180, 0, 'YXZ');
    ctx.camera.updateMatrixWorld(true);
    ctx.viewScene.visible = false;
    (${esconderUI.toString()})();
    window.__game.settle(20);
  })()`, 'rua ao pe do jogador (~1,5 m)');

  await foto('rua-media', `(() => {
    const c = ${JSON.stringify(pontos.rua)}, k = ${JSON.stringify(pontos.panoRua)};
    const ctx = window.__game.ctx;
    ctx.state = 'pausado';
    ctx.camera.position.set(k.cx, k.cy, k.cz);
    ctx.camera.up.set(0,1,0);
    ctx.camera.lookAt(c.x, c.y, c.z);
    ctx.camera.updateMatrixWorld(true);
    ctx.viewScene.visible = false;
    (${esconderUI.toString()})();
    window.__game.settle(20);
  })()`, 'rua a media/longa distancia');
}

// Conversa de paleta: procura um enquadramento que tenha TERRENO, RUA e
// CALCADA ao mesmo tempo — e a unica vista que prova se as tres superficies
// convivem ou brigam.
await foto('paleta', `(() => {
  const ctx = window.__game.ctx;
  ctx.state = 'pausado';
  const col = ctx.world.collision;
  const rua = ${JSON.stringify(pontos.rua)};
  const campo = ${JSON.stringify(pontos.campo)};
  const base = rua || campo;
  const solo = (x,z) => col.raycast({x,y:95,z},{x:0,y:-1,z:0},220);
  let melhor = null;
  for (let k = 0; k < 64; k++) {
    const ang = (k/64)*Math.PI*2;
    for (const d of [6, 10, 14, 19]) {
      const cx = base.x + Math.sin(ang)*d, cz = base.z + Math.cos(ang)*d;
      const g = solo(cx, cz);
      if (!g.hit) continue;
      const cy = g.point.y + 1.68;
      // olha de volta para o ponto base e conta o que aparece no leque frontal
      const yaw = Math.atan2(base.x - cx, base.z - cz);
      const vistos = {};
      let alvos = 0;
      for (let a = -32; a <= 32; a += 4) {
        for (const t of [3, 6, 10, 16, 24, 34]) {
          const ra = yaw + a*Math.PI/180;
          const q = solo(cx + Math.sin(ra)*t, cz + Math.cos(ra)*t);
          if (!q.hit) continue;
          vistos[q.surface] = (vistos[q.surface]||0) + 1;
        }
      }
      // quer terra E asfalto no mesmo quadro; calcada costuma ficar na fronteira
      const temTerra = (vistos.terra||0) >= 4, temRua = (vistos.asfalto||0) >= 4;
      if (!temTerra || !temRua) continue;
      // Nada de parede colada na lente: a foto anterior nasceu encostada num
      // muro de tijolo e nao provava nada sobre chao.
      const frente = col.raycast({x:cx,y:cy,z:cz},
        {x:Math.sin(yaw),y:-0.28,z:Math.cos(yaw)}, 9);
      if (frente.hit && frente.distance < 6 && frente.normal.y < 0.5) continue;
      alvos = Math.min(vistos.terra, vistos.asfalto) + Object.keys(vistos).length*3;
      if (!melhor || alvos > melhor.alvos) melhor = { alvos, cx, cy, cz, yaw, vistos };
    }
  }
  if (!melhor) {
    const g = solo(campo.x, campo.z);
    melhor = { cx: campo.x, cy: (g.hit?g.point.y:campo.y)+1.68, cz: campo.z,
               yaw: Math.atan2(base.x-campo.x, base.z-campo.z), vistos:{} };
  }
  ctx.camera.position.set(melhor.cx, melhor.cy, melhor.cz);
  ctx.camera.up.set(0,1,0);
  ctx.camera.rotation.set(-17*Math.PI/180, melhor.yaw, 0, 'YXZ');
  ctx.camera.updateMatrixWorld(true);
  ctx.viewScene.visible = false;
  (${esconderUI.toString()})();
  window.__game.settle(20);
  window.__paleta = melhor.vistos;
})()`, 'terreno + rua + calcada + folhagem no mesmo quadro');

// mosaico
const m = await b.newPage({ viewport: { width: 2580, height: 1480 } });
const html = tiros.map((t) => {
  const b64 = readFileSync(t.arq).toString('base64');
  return `<figure><img src="data:image/png;base64,${b64}"><figcaption>${t.legenda}</figcaption></figure>`;
}).join('');
await m.setContent(`<style>body{margin:0;background:#111;font:15px monospace;color:#eee}
  main{display:grid;grid-template-columns:repeat(2,1280px);gap:6px;padding:6px}
  figure{margin:0;position:relative}img{display:block;width:1280px}
  figcaption{position:absolute;left:6px;top:6px;background:#000b;padding:4px 9px}</style><main>${html}</main>`);
await m.setViewportSize({ width: 2580, height: 20 + Math.ceil(tiros.length / 2) * 726 });
await m.screenshot({ path: `${ROOT}/shots/chao-${ROTULO}.png`, fullPage: true });
console.log(`\n-> shots/chao-${ROTULO}.png`);

await b.close();
