/**
 * casas.mjs — auditoria EXAUSTIVA de "nao dá para sair".
 *
 * Responde, para TODAS as casas do mapa (a seed e fixa, entao e deterministico):
 *
 *   1. INTERIOR — a casa tem interior jogavel? A capsula do jogador cabe la
 *      dentro? Existe caminho ATRAVESSAVEL da rua para dentro e de volta?
 *   2. TELHADO — todo ponto em pe no telhado tem descida ate o chao sem queda
 *      maior que QUEDA_OK?
 *
 * Metodo (nada de amostragem):
 *
 *   INTERIOR: BFS com `collision.capsuleSweep` de verdade, celula de 0,3 m, a
 *   partir do miolo da casa. Passo aceito so quando o sweep entrega a posicao
 *   pedida (ou seja: a capsula PASSOU). O caminho de volta e medido a parte,
 *   partindo de fora — nao se assume simetria.
 *
 *   TELHADO: monta o GRAFO DE SUPERFICIES do mapa inteiro. Para cada celula de
 *   0,5 m, raios para baixo em cascata acham todas as lajes/telhados/chao
 *   empilhados naquele ponto; sobra nivel onde ha 1,85 m de pe-direito livre.
 *   Aresta de caminhada quando |dy| <= DEGRAU; aresta de queda (mao unica) para
 *   baixo, com a altura registrada. "Tem descida" = existe caminho ate uma
 *   celula de chao usando so quedas <= QUEDA_OK. "Alcancavel" = da para chegar
 *   la de baixo (degrau, mantle de 1,30 m ou queda de cima). ILHADO = alcancavel
 *   e sem descida — exatamente a reclamacao do jogador.
 *
 * ARMADILHAS ja pagas aqui (nao repita):
 *   · `collision.raycast` devolve SEMPRE o mesmo objeto: copiar antes do proximo raio.
 *   · `capsuleSweep` idem (`_cs`).
 *   · `navGrid.isWalkable` recebe indices de CELULA, nao metros.
 *   · `page.waitForFunction(fn, {timeout})` ignora o timeout: a assinatura e
 *     `(fn, arg, options)`.
 *
 *   node tools/casas.mjs [tag]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 5231);
const TAG = process.argv[2] || 'depois';

/* ------------------------------------------------------------------ vite */
const vite = spawn(process.execPath, [
  ROOT + '/node_modules/vite/bin/vite.js',
  '--config', ROOT + '/tools/vite.diag.config.js',
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
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
p.on('pageerror', (e) => console.log('PAGEERR:', e.message.split('\n')[0]));
p.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE:', m.text().slice(0, 160)); });
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__game?.ready, null, { timeout: 300000 });
await p.waitForTimeout(1200);

/* =================================================================== */
/* A auditoria roda DENTRO da pagina: precisa do BVH de colisao real.    */
/* =================================================================== */
const rel = await p.evaluate(async () => {
  const ctx = window.__game.ctx;
  const world = ctx.world;
  const col = world.collision;
  const casas = world.favela.casas;
  const terr = world.terrain;

  /* --- constantes do jogador (src/player/Movement.js DIM) --- */
  const RAIO = 0.35, ALTURA = 1.80, DEGRAU = 0.40, MANTLE = 1.30;
  /** Queda que conta como "descida" e nao como "se jogar do telhado". */
  const QUEDA_OK = 2.5;
  /** Pe-direito minimo para a capsula ficar de pe numa superficie. */
  const PE_DIREITO = 1.85;

  // Vector3 sem importar three: pegamos a classe emprestada do proprio jogo.
  const proto = world.group.position.constructor;
  const v3 = (x = 0, y = 0, z = 0) => new proto(x, y, z);

  const _a = v3(), _b = v3(), _d = v3(0, -1, 0);

  /** Raycast para baixo copiando o resultado NA HORA (o objeto e reusado). */
  function raioBaixo(x, yTopo, z, alcance) {
    _a.set(x, yTopo, z);
    const h = col.raycast(_a, _d, alcance);
    if (!h.hit) return null;
    return { y: h.point.y, ny: h.normal.y, sup: h.surface, dist: h.distance };
  }

  /* =============================================================== */
  /* PARTE 1 — INTERIORES                                             */
  /* =============================================================== */

  /** Ponto dentro da planta orientada da casa, com margem. */
  function emObbSimples(px, pz, o, margem) {
    const cc = Math.cos(o.yaw), ss = Math.sin(o.yaw);
    const dx = px - o.x, dz = pz - o.z;
    const lx = dx * cc - dz * ss, lz = dx * ss + dz * cc;
    return Math.abs(lx) <= o.w * 0.5 + margem && Math.abs(lz) <= o.d * 0.5 + margem;
  }

  /** Sweep de capsula copiando o que interessa (o retorno e reusado). */
  function sweep(fx, fy, fz, tx, ty, tz) {
    _a.set(fx, fy, fz); _b.set(tx, ty, tz);
    const r = col.capsuleSweep(_a, _b, RAIO, ALTURA, DEGRAU);
    return { x: r.position.x, y: r.position.y, z: r.position.z, chao: r.grounded };
  }

  /** A capsula cabe parada em (x,y,z)? (sweep degenerado nao pode empurrar). */
  function cabe(x, y, z) {
    const r = sweep(x, y, z, x, y, z);
    return Math.hypot(r.x - x, r.z - z) < 0.02 && Math.abs(r.y - y) < 0.30;
  }

  /**
   * BFS de caminhada com a capsula de verdade.
   *
   * ## Por que a celula guarda a posicao REAL, e nao o centro dela
   * A porta tem 0,92 m e a capsula 0,70: sobram 11 cm de cada lado. Com o no
   * ancorado no centro da celula, atravessar o vao so dava certo se a grade por
   * acaso caisse alinhada com ele — e a grade e do mundo, a porta e da casa, com
   * yaw qualquer. Seis casas foram reprovadas por isso, e nao por defeito do
   * mundo. Guardando o resultado do `capsuleSweep` (que ja desliza na parede,
   * como o jogador desliza), o caminho medido e um caminho que a capsula
   * percorreu de fato.
   *
   * @param {object} o {x0,z0,y0, cx,cz, raio, passo, alvo(fn)}
   * @returns {{ok:boolean, visitados:number, melhor:number}}
   */
  function andarBFS(o) {
    const passo = o.passo ?? 0.25;
    const raio = o.raio;
    const n = Math.ceil(raio / passo) * 2 + 1;
    const meio = (n / 2) | 0;
    const visto = new Uint8Array(n * n);
    const alt = new Float32Array(n * n);
    const posX = new Float32Array(n * n);
    const posZ = new Float32Array(n * n);
    const fila = new Int32Array(n * n);
    let cab = 0, cau = 0;
    const idx = (i, j) => j * n + i;

    const k0 = idx(meio, meio);
    visto[k0] = 1; alt[k0] = o.y0; posX[k0] = o.x0; posZ[k0] = o.z0; fila[cau++] = k0;
    let melhor = 0, ok = false;
    let saidaX = 0, saidaY = 0, saidaZ = 0;
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

    while (cab < cau) {
      const k = fila[cab++];
      const i = k % n, j = (k / n) | 0;
      const x = posX[k], z = posZ[k];
      const y = alt[k];
      const dist = Math.hypot(x - o.cx, z - o.cz);
      if (dist > melhor) melhor = dist;
      if (o.alvo(x, y, z, dist)) { ok = true; saidaX = x; saidaY = y; saidaZ = z; break; }
      for (const [di, dj] of DIRS) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
        const nk = idx(ni, nj);
        if (visto[nk]) continue;
        const nx = o.x0 + (ni - meio) * passo, nz = o.z0 + (nj - meio) * passo;
        const r = sweep(x, y, z, nx, y, nz);
        // aceita quando a capsula chegou PERTO do alvo: o resto foi deslizamento
        // em parede, que e movimento legitimo e nao "bateu e parou"
        if (Math.hypot(r.x - nx, r.z - nz) > passo * 0.75) continue;

        /* Movimento do JOGADOR, nao so caminhada plana. Modelar so `|dy| <=
         * DEGRAU` reprovava a porta de casa por causa da soleira: sair era
         * "cair" 0,8 m e entrar era um mantle, e nenhum dos dois passava. O
         * jogador faz os dois sem pensar. */
        let ny = r.y, rx = r.x, rz = r.z;
        if (!r.chao) {
          // saiu no vazio: cai ate o que houver embaixo
          const g = raioBaixo(rx, y + 0.4, rz, 40);
          if (!g || g.ny < 0.5) continue;
          ny = g.y;
        }
        const dyy = ny - y;
        if (dyy > MANTLE) continue;                  // alto demais para escalar
        if (dyy < -QUEDA_OK) continue;               // queda longa demais
        if (!cabe(rx, ny + 0.02, rz)) continue;      // pousou dentro de geometria
        visto[nk] = 1; alt[nk] = ny; posX[nk] = rx; posZ[nk] = rz; fila[cau++] = nk;
      }
    }
    return { ok, visitados: cau, melhor: +melhor.toFixed(2), x: saidaX, y: saidaY, z: saidaZ };
  }

  /* ---------------------------------------------------------------- portas */
  const portas = world.portas;

  /** A porta e mirável e acionável de um ponto? Caminho real do jogo. */
  function acionavelDe(porta, px, pz) {
    const olho = v3(px, porta.eixo.y + 1.68, pz);
    const dir = v3(porta.obb.x, porta.obb.y, porta.obb.z).sub(olho);
    const d = dir.length();
    if (d > 2.1) return false;
    dir.multiplyScalar(1 / d);
    return portas.alvoNaMira(olho, dir, 2.1) === porta;
  }

  /* Acionavel dos dois lados, com a porta FECHADA — que e a situacao que
   * importa: o jogador esta trancado dentro e precisa achar a porta.
   * `nx/nz` aponta para FORA, entao dentro = centro - n. */
  const acaoPortas = new Map();
  if (portas) {
    for (const p of portas.lista) {
      const cx = p.eixo.x + Math.cos(p.yawBase) * p.w * 0.5;
      const cz = p.eixo.z - Math.sin(p.yawBase) * p.w * 0.5;
      const rec = acaoPortas.get(p.casa) || { dentro: false, fora: false, n: 0 };
      rec.n++;
      if (acionavelDe(p, cx - p.nx * 0.9, cz - p.nz * 0.9)) rec.dentro = true;
      if (acionavelDe(p, cx + p.nx * 0.9, cz + p.nz * 0.9)) rec.fora = true;
      acaoPortas.set(p.casa, rec);
    }
    /* Agora ABERTAS para o teste de travessia. Medir com a folha fechada
     * responderia "da para atravessar porta fechada?", que nao e a pergunta —
     * a folha barra de proposito. A pergunta e "existe saida", e a saida passa
     * por abrir. */
    const A = Math.PI * 0.46;
    for (const p of portas.lista) { p.ang = A; p.alvo = A; portas._aplicar(p); }
  }

  const interiores = [];
  for (let ci = 0; ci < casas.length; ci++) {
    const c = casas[ci];
    if (!c.interior && !c.tunel) continue;
    const meia = Math.max(c.w, c.d) * 0.5;
    /* Piso do terreo. O raio parte de 1,5 m acima da base — altura de peito,
     * dentro do comodo e dentro do tunel. Partindo do pe-direito (como antes)
     * ele nascia DENTRO da laje do teto na casa-tunel, cuja altura livre e
     * 2,45 m, e devolvia o topo dessa laje como "piso": a auditoria punha a
     * capsula em cima da casa e concluia que ela nao andava. */
    let pisoY = c.baseY + 0.20;
    const sonda = raioBaixo(c.x, c.baseY + 1.5, c.z, 4);
    if (sonda && sonda.ny > 0.5) pisoY = sonda.y + 0.02;

    const dentro = cabe(c.x, pisoY, c.z);
    let saiu = false, voltou = false, det = '';
    if (!dentro) {
      det = 'capsula nao cabe no miolo';
    } else {
      /* Sair = estar 1,2 m FORA DA PLANTA da casa (nao a 'meia + 2,2 m do
       * centro', que era um circulo e por isso exigia atravessar meio beco em
       * casa comprida — e na casa-tunel exigia sair pela lateral macica). */
      const s = andarBFS({
        x0: c.x, z0: c.z, y0: pisoY, cx: c.x, cz: c.z,
        raio: meia + 4.0, passo: 0.25,
        // ... e no nivel do beco, nao em cima do telhado
        alvo: (x, y, z) => y < pisoY + 1.4 && !emObbSimples(x, z, c, 1.2),
      });
      saiu = s.ok;
      if (!saiu) det = `preso: alcancou ${s.melhor} m do centro (planta ${c.w.toFixed(1)}x${c.d.toFixed(1)})`;

      /* Volta: parte de um ponto livre do lado de fora, de preferencia em frente
       * a porta. Varias distancias porque a primeira pode cair dentro do muro do
       * vizinho — e ai o teste reprovaria o ponto de partida, nao a casa. */
      const ancPortas = (world.buildings?.ancoras?.portas ?? []).filter((q) => q.casa === c);
      let px = c.x, pz = c.z, achouFora = false;
      const tentarFora = (ex, ez) => {
        const g = raioBaixo(ex, c.baseY + 8, ez, 16);
        if (!g || g.ny < 0.5) return false;
        if (!cabe(ex, g.y + 0.05, ez)) return false;
        px = ex; pz = ez; return true;
      };
      /* Melhor ponto de partida possivel: EXATAMENTE onde a saida desembocou.
       * Escolher o ponto na mao (a tantos metros da porta) ja reprovou casas por
       * o ponto cair dentro do muro do vizinho — o teste media o palpite, nao a
       * casa. Se ha caminho de dentro para fora, a volta comeca na outra ponta
       * DESSE caminho. */
      if (saiu && tentarFora(s.x, s.z)) achouFora = true;
      for (const q of achouFora ? [] : ancPortas) {
        for (const dd of [1.4, 1.9, 2.5]) {
          if (tentarFora(q.x + q.nx * dd, q.z + q.nz * dd)) { achouFora = true; break; }
        }
        if (achouFora) break;
      }
      if (!achouFora) {
        // sem porta (tunel): tenta sair pelos quatro lados da planta
        const co = Math.cos(c.yaw), si = Math.sin(c.yaw);
        for (const [lx, lz] of [[c.w * 0.5 + 1.5, 0], [-c.w * 0.5 - 1.5, 0],
          [0, c.d * 0.5 + 1.5], [0, -c.d * 0.5 - 1.5]]) {
          if (tentarFora(c.x + lx * co + lz * si, c.z - lx * si + lz * co)) { achouFora = true; break; }
        }
      }
      if (achouFora) {
        const g = raioBaixo(px, c.baseY + 6, pz, 12);
        const v = andarBFS({
          x0: px, z0: pz, y0: g.y + 0.05, cx: c.x, cz: c.z,
          raio: meia + 4.6, passo: 0.25,
          // voltar e chegar ao miolo NO PISO do terreo — pisar no telhado da
          // casa nao e "voltar para dentro"
          alvo: (x, y, z, dist) => dist < 0.9 && Math.abs(y - pisoY) < 1.0,
        });
        voltou = v.ok;
      }
    }
    const ac = acaoPortas.get(c) || null;
    interiores.push({
      i: ci, x: +c.x.toFixed(1), z: +c.z.toFixed(1), w: +c.w.toFixed(1), d: +c.d.toFixed(1),
      tunel: !!c.tunel, andares: c.andares.length, dentro, saiu, voltou, det,
      nPortas: ac ? ac.n : 0,
      acaoDentro: ac ? ac.dentro : null,
      acaoFora: ac ? ac.fora : null,
    });
  }

  /* =============================================================== */
  /* PARTE 2 — GRAFO DE SUPERFICIES (telhados)                        */
  /* =============================================================== */
  const CEL = 0.5;
  const TAM = world.size;
  const W = Math.round(TAM / CEL);
  const ORIG = -TAM / 2;
  const NIV = 5;                                  // niveis empilhados por celula
  const yNiv = new Float32Array(W * W * NIV);
  const nNiv = new Uint8Array(W * W);
  const okNiv = new Uint8Array(W * W * NIV);       // 1 = da para ficar de pe

  const cx0 = (i) => ORIG + (i + 0.5) * CEL;

  for (let j = 0; j < W; j++) {
    for (let i = 0; i < W; i++) {
      const x = cx0(i), z = cx0(j);
      const base = terr.heightAt(x, z);
      let y = base + 42;
      let n = 0;
      const topo = [];
      for (let k = 0; k < NIV; k++) {
        const h = raioBaixo(x, y, z, y - (base - 3));
        if (!h) break;
        topo.push(h);
        y = h.y - 0.05;
        n++;
        if (h.y <= base + 0.05) break;             // chegou no terreno
      }
      const kk = (j * W + i) * NIV;
      for (let k = 0; k < n; k++) {
        yNiv[kk + k] = topo[k].y;
        // pe-direito: distancia ate a superficie de CIMA (a anterior na lista)
        const teto = k === 0 ? Infinity : topo[k - 1].y;
        const livre = teto - topo[k].y;
        okNiv[kk + k] = (topo[k].ny >= 0.5 && livre >= PE_DIREITO) ? 1 : 0;
      }
      nNiv[j * W + i] = n;
    }
  }

  /* Descarta superficie ESTREITA demais para a capsula (raio 0,35 m).
   *
   * Sem isto o topo da mureta da laje — 14 cm de largura — virava no de pleno
   * direito: a celula de 50 cm cai em cima dela, a normal aponta para cima e o
   * pe-direito e o ceu. O jogador nao fica de pe ali, mas a auditoria contava
   * esses nos como "ponto do telhado sem descida" e inflava a reprovacao. Uma
   * superficie de verdade tem pelo menos dois vizinhos na mesma cota. */
  for (let j = 0; j < W; j++) {
    for (let i = 0; i < W; i++) {
      const c = j * W + i, kk = c * NIV;
      for (let k = 0; k < nNiv[c]; k++) {
        if (!okNiv[kk + k]) continue;
        const y = yNiv[kk + k];
        let vizinhos = 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ni = i + di, nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= W || nj >= W) continue;
          const nc = nj * W + ni, nkk = nc * NIV;
          for (let k2 = 0; k2 < nNiv[nc]; k2++) {
            if (Math.abs(yNiv[nkk + k2] - y) <= 0.28) { vizinhos++; break; }
          }
        }
        if (vizinhos < 2) okNiv[kk + k] = 0;
      }
    }
  }

  /* --- indices de no --- */
  const noId = new Int32Array(W * W * NIV).fill(-1);
  const noX = [], noY = [], noZ = [], noChao = [];
  for (let j = 0; j < W; j++) {
    for (let i = 0; i < W; i++) {
      const c = j * W + i, kk = c * NIV;
      for (let k = 0; k < nNiv[c]; k++) {
        if (!okNiv[kk + k]) continue;
        noId[kk + k] = noX.length;
        const x = cx0(i), z = cx0(j);
        noX.push(x); noY.push(yNiv[kk + k]); noZ.push(z);
        noChao.push(yNiv[kk + k] <= terr.heightAt(x, z) + 0.7 ? 1 : 0);
      }
    }
  }
  const N = noX.length;

  /** Nivel de uma celula vizinha mais proximo em altura de `y`. */
  function nivelPerto(i, j, y) {
    if (i < 0 || j < 0 || i >= W || j >= W) return -1;
    const c = j * W + i, kk = c * NIV;
    let melhor = -1, dmin = Infinity;
    for (let k = 0; k < nNiv[c]; k++) {
      if (noId[kk + k] < 0) continue;
      const dy = Math.abs(yNiv[kk + k] - y);
      if (dy < dmin) { dmin = dy; melhor = k; }
    }
    return melhor;
  }

  /* --- arestas: para cada no, os vizinhos das 4 celulas adjacentes --- */
  const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const adj = new Array(N);
  for (let n = 0; n < N; n++) adj[n] = [];
  for (let j = 0; j < W; j++) {
    for (let i = 0; i < W; i++) {
      const c = j * W + i, kk = c * NIV;
      for (let k = 0; k < nNiv[c]; k++) {
        const a = noId[kk + k];
        if (a < 0) continue;
        const ya = yNiv[kk + k];
        for (const [di, dj] of DIRS4) {
          const ni = i + di, nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= W || nj >= W) continue;
          const nc = nj * W + ni, nkk = nc * NIV;
          // liga com TODOS os niveis do vizinho, nao so o mais proximo:
          // e assim que "pular da laje para o beco" aparece no grafo.
          for (let k2 = 0; k2 < nNiv[nc]; k2++) {
            const bnode = noId[nkk + k2];
            if (bnode < 0) continue;
            const yb = yNiv[nkk + k2];
            const dy = ya - yb;                     // >0 = descer
            if (Math.abs(dy) <= DEGRAU + 0.02) adj[a].push([bnode, 0]);
            else if (dy > 0) adj[a].push([bnode, dy]);      // queda de `dy`
            else if (-dy <= MANTLE) adj[a].push([bnode, -1]); // mantle para cima
          }
        }
      }
    }
  }
  void nivelPerto;

  /* --- MUNDO LIVRE: o que se alcanca a pe a partir da rua principal ---
   *
   * "Descer do telhado" nao e cair em qualquer chao: e voltar para o mapa
   * jogavel. Cair num pateo fechado entre quatro casas e continuar preso, so
   * que embaixo. Entao a raiz do BFS e a rua, e o alvo da descida e ESTE
   * conjunto — nao "chao" generico.
   *
   * Movimentos permitidos: degrau (<=DEGRAU nos dois sentidos), mantle para
   * cima (<=MANTLE) e queda controlada para baixo (<=QUEDA_OK). */
  const livre = new Uint8Array(N);
  {
    const rua = world.favela.vias[0];
    const fila = new Int32Array(N); let cab = 0, cau = 0;
    for (let k = 0; k < rua.pts.length; k += 3) {
      const px = rua.pts[k][0], pz = rua.pts[k][1];
      const i = Math.round((px - ORIG) / CEL - 0.5), j = Math.round((pz - ORIG) / CEL - 0.5);
      if (i < 0 || j < 0 || i >= W || j >= W) continue;
      const c = j * W + i, kk = c * NIV;
      for (let l = 0; l < nNiv[c]; l++) {
        const n = noId[kk + l];
        if (n >= 0 && noChao[n] && !livre[n]) { livre[n] = 1; fila[cau++] = n; }
      }
    }
    while (cab < cau) {
      const n = fila[cab++];
      for (const [m, q] of adj[n]) {
        if (livre[m]) continue;
        if (q > QUEDA_OK) continue;                // queda longa demais: nao e caminho
        livre[m] = 1; fila[cau++] = m;
      }
    }
  }

  /* --- alcancavel de baixo: BFS do mundo livre, com queda de qualquer altura --- */
  const alcanca = new Uint8Array(N);
  {
    const fila = new Int32Array(N); let cab = 0, cau = 0;
    for (let n = 0; n < N; n++) if (livre[n]) { alcanca[n] = 1; fila[cau++] = n; }
    while (cab < cau) {
      const n = fila[cab++];
      for (const [m] of adj[n]) { if (!alcanca[m]) { alcanca[m] = 1; fila[cau++] = m; } }
    }
  }

  /* Bolsoes de chao fora do mundo livre: pateo fechado, vao entre casas, poco
   * de luz. Quem cai ali "desceu" e continua preso — por isso nao servem de
   * destino de descida. */
  let chaoPreso = 0;
  for (let n = 0; n < N; n++) if (noChao[n] && !livre[n]) chaoPreso++;

  /**
   * Descida: para cada no, a MENOR queda MAXIMA de um caminho ate o chao
   * ("caminho minimax"). Zero = desce andando. Infinito = nao ha saida nenhuma,
   * nem se jogando. Este numero e a resposta honesta a "da para descer?" —
   * pass/fail sozinho esconde a diferenca entre um degrau e um voo de 12 m.
   *
   * Dijkstra minimax com fila de baldes de 5 cm (queda maxima util ~40 m).
   * Subir (mantle) custa ZERO: pular a mureta para chegar na beirada certa faz
   * parte da descida.
   */
  const custo = new Float32Array(N).fill(Infinity);
  {
    const rev = new Array(N);
    for (let n = 0; n < N; n++) rev[n] = [];
    for (let n = 0; n < N; n++) {
      for (const [m, q] of adj[n]) rev[m].push([n, q > 0 ? q : 0]);
    }
    const PASSO_B = 0.05, NB = 900;
    const baldes = new Array(NB);
    for (let k = 0; k < NB; k++) baldes[k] = [];
    for (let n = 0; n < N; n++) if (livre[n]) { custo[n] = 0; baldes[0].push(n); }
    for (let k = 0; k < NB; k++) {
      const bk = baldes[k];
      for (let t = 0; t < bk.length; t++) {
        const n = bk[t];
        const cn = custo[n];
        if (cn > (k + 1) * PASSO_B) continue;      // entrada obsoleta
        for (const [m, c] of rev[n]) {
          const novo = c > cn ? c : cn;
          if (novo < custo[m]) {
            custo[m] = novo;
            const kb = Math.min(NB - 1, Math.ceil(novo / PASSO_B));
            if (kb >= k) baldes[kb].push(m); else bk.push(m);
          }
        }
      }
      bk.length = 0;
    }
  }
  const desce = new Uint8Array(N);
  for (let n = 0; n < N; n++) desce[n] = custo[n] <= QUEDA_OK ? 1 : 0;

  /* --- por casa: nos de telhado --- */
  function emObb(px, pz, o, margem) {
    const cc = Math.cos(o.yaw), ss = Math.sin(o.yaw);
    const dx = px - o.x, dz = pz - o.z;
    const lx = dx * cc - dz * ss, lz = dx * ss + dz * cc;
    return Math.abs(lx) <= o.w * 0.5 + margem && Math.abs(lz) <= o.d * 0.5 + margem;
  }

  const telhados = [];
  // indice espacial de nos por celula para nao varrer N por casa
  const porCel = new Map();
  for (let n = 0; n < N; n++) {
    const i = Math.round((noX[n] - ORIG) / CEL - 0.5);
    const j = Math.round((noZ[n] - ORIG) / CEL - 0.5);
    const k = j * W + i;
    let a = porCel.get(k); if (!a) { a = []; porCel.set(k, a); }
    a.push(n);
  }

  for (let ci = 0; ci < casas.length; ci++) {
    const c = casas[ci];
    // planta e cota do TELHADO (nao do terreo): o ultimo andar pode avancar
    const cw = Math.max(c.w, c.telhadoW ?? 0), cd = Math.max(c.d, c.telhadoD ?? 0);
    const obbTelhado = { x: c.x, z: c.z, w: cw, d: cd, yaw: c.yaw };
    const topoY = (c.telhadoY ?? (c.baseY + c.alturaTotal)) - 0.2;
    const R = Math.hypot(cw, cd) * 0.5 + 0.8;
    const i0 = Math.max(0, Math.floor((c.x - R - ORIG) / CEL));
    const i1 = Math.min(W - 1, Math.min(W - 1, Math.ceil((c.x + R - ORIG) / CEL)));
    const j0 = Math.max(0, Math.floor((c.z - R - ORIG) / CEL));
    const j1 = Math.min(W - 1, Math.ceil((c.z + R - ORIG) / CEL));
    let nos = 0, presos = 0, alc = 0, alcPresos = 0, yMax = -Infinity;
    let pior = 0, semSaida = 0;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const arr = porCel.get(j * W + i);
        if (!arr) continue;
        for (const n of arr) {
          if (!emObb(noX[n], noZ[n], obbTelhado, 0.2)) continue;
          if (noY[n] < topoY - 1.0) continue;       // so o nivel do telhado
          nos++;
          if (noY[n] > yMax) yMax = noY[n];
          const q = custo[n];
          if (!isFinite(q)) semSaida++;
          else if (q > pior) pior = q;
          if (!desce[n]) presos++;
          if (alcanca[n]) { alc++; if (!desce[n]) alcPresos++; }
        }
      }
    }
    telhados.push({
      i: ci, x: +c.x.toFixed(1), z: +c.z.toFixed(1), topo: c.topo,
      andares: c.andares.length, altura: +(c.alturaTotal).toFixed(1),
      nos, presos, alc, alcPresos, semSaida,
      // maior "queda minima necessaria" entre os pontos do telhado desta casa
      pior: semSaida > 0 ? null : +pior.toFixed(2),
      yTelhado: yMax === -Infinity ? null : +yMax.toFixed(1),
    });
  }

  return {
    stats: world.stats,
    nCasas: casas.length,
    nInterior: casas.filter((c) => c.interior).length,
    nTunel: casas.filter((c) => c.tunel).length,
    nNos: N,
    nLivres: livre.reduce((a, b) => a + b, 0),
    chaoPreso,
    interiores,
    telhados,
  };
});

/* =================================================================== */
/* Relatorio                                                            */
/* =================================================================== */
const int = rel.interiores;
const intReprov = int.filter((c) => !c.dentro || !c.saiu || !c.voltou);
const semCabe = int.filter((c) => !c.dentro);
const semSaida = int.filter((c) => c.dentro && !c.saiu);
const semVolta = int.filter((c) => c.dentro && c.saiu && !c.voltou);

const tel = rel.telhados;
const comTelhado = tel.filter((t) => t.nos > 0);
const telAlcancavel = tel.filter((t) => t.alc > 0);
const telIlhado = tel.filter((t) => t.alcPresos > 0);
const telPresoQualquer = tel.filter((t) => t.presos > 0);

console.log(`\n================ AUDITORIA DE CASAS (${TAG}) ================`);
console.log(`casas: ${rel.nCasas}  ·  com interior jogavel: ${rel.nInterior}  ·  tunel: ${rel.nTunel}`);
console.log(`nos de superficie no grafo: ${rel.nNos}  ·  no mundo livre (a pe desde a rua): ${rel.nLivres}`);
console.log(`celulas de CHAO fora do mundo livre (pateo/vao fechado): ${rel.chaoPreso}`);

const semPorta = int.filter((c) => !c.tunel && c.nPortas === 0);
const semAcaoDentro = int.filter((c) => c.nPortas > 0 && !c.acaoDentro);
const semAcaoFora = int.filter((c) => c.nPortas > 0 && !c.acaoFora);

console.log(`\n--- 1. INTERIORES (${int.length} casas com interior/tunel) ---`);
console.log(`REPROVADAS: ${intReprov.length} / ${int.length}`);
console.log(`  capsula nao cabe no miolo .......... ${semCabe.length}`);
console.log(`  cabe mas NAO SAI (preso) ........... ${semSaida.length}`);
console.log(`  sai mas NAO CONSEGUE VOLTAR ........ ${semVolta.length}`);
console.log(`  casa com interior e SEM PORTA ...... ${semPorta.length}`);
console.log(`  porta nao acionavel POR DENTRO ..... ${semAcaoDentro.length}`);
console.log(`  porta nao acionavel POR FORA ....... ${semAcaoFora.length}`);
for (const c of intReprov.slice(0, 12)) {
  console.log(`   #${c.i} (${c.x}, ${c.z}) ${c.w}x${c.d} ${c.tunel ? 'TUNEL ' : ''}` +
    `dentro=${c.dentro} saiu=${c.saiu} voltou=${c.voltou}  ${c.det}`);
}
if (intReprov.length > 12) console.log(`   ... e mais ${intReprov.length - 12}`);

const semSaidaNenhuma = tel.filter((t) => t.semSaida > 0);
const faixa = (lo, hi) => tel.filter((t) => t.pior !== null && t.pior > lo && t.pior <= hi).length;

console.log(`\n--- 2. TELHADOS (${rel.nCasas} casas) ---`);
console.log(`casas com telhado pisavel .............. ${comTelhado.length}`);
console.log(`  ... alcancavel do chao (modelo conservador) ... ${telAlcancavel.length}`);
console.log(`REPROVADAS (algum ponto sem descida <= 2,5 m) ... ${telPresoQualquer.length}`);
console.log(`  dessas, ilhadas E comprovadamente alcancaveis . ${telIlhado.length}`);
console.log(`  dessas, SEM SAIDA NENHUMA (nem se jogando) .... ${semSaidaNenhuma.length}`);
console.log(`\nqueda minima necessaria para descer (pior ponto de cada telhado):`);
console.log(`  desce andando (0 m) ....... ${faixa(-1, 0.001)}`);
console.log(`  degrau ate 1,3 m .......... ${faixa(0.001, 1.3)}`);
console.log(`  queda ate 2,5 m ........... ${faixa(1.3, 2.5)}`);
console.log(`  queda 2,5 a 4 m ........... ${faixa(2.5, 4)}`);
console.log(`  queda 4 a 7 m ............. ${faixa(4, 7)}`);
console.log(`  queda acima de 7 m ........ ${faixa(7, 1e9)}`);
console.log(`  sem saida (infinito) ...... ${semSaidaNenhuma.length}`);
const ordenado = telPresoQualquer.slice()
  .sort((a, b) => (b.pior === null ? 1e9 : b.pior) - (a.pior === null ? 1e9 : a.pior));
for (const t of ordenado.slice(0, 14)) {
  console.log(`   #${t.i} (${t.x}, ${t.z}) ${t.andares} and. topo=${t.topo} ` +
    `y=${t.yTelhado}  nos=${t.nos} alc=${t.alc} presos=${t.presos} ` +
    `queda=${t.pior === null ? 'SEM SAIDA' : t.pior + ' m'}`);
}
if (ordenado.length > 14) console.log(`   ... e mais ${ordenado.length - 14}`);

console.log(`\n>>> RESUMO ${TAG}: interiores reprovados ${intReprov.length}/${int.length} · ` +
  `telhados reprovados ${telPresoQualquer.length}/${comTelhado.length}`);

writeFileSync(`${ROOT}/tools/casas.${TAG}.json`, JSON.stringify(rel, null, 1));
console.log(`(detalhe completo em tools/casas.${TAG}.json)`);

await b.close();
vite.kill();
