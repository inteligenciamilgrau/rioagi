/**
 * TextureLab.js — a oficina de texturas. Dono: MAT.
 *
 * Responsabilidades:
 *  - alocar e reciclar os buffers de trabalho (albedo RGBA + campos escalares);
 *  - derivar normal map do height por **Sobel com wrap** (nunca normal aleatório);
 *  - derivar AO por **cavidade** (height − height borrado), que é o que dá profundidade;
 *  - empacotar AO/Roughness/Metalness num único RGB (convenção glTF ORM) — 1 textura
 *    em vez de 3, economizando VRAM e chamadas de upload;
 *  - criar as THREE.DataTexture com colorSpace/wrap/anisotropia corretos;
 *  - ceder o thread (`await`) periodicamente para a aba não congelar.
 *
 * ## Convenção de orientação (importante)
 * DataTexture tem `flipY = false`. Portanto a **linha 0 do buffer é v = 0**, ou seja,
 * o *rodapé* da textura. Logo:
 *   - sujeira/musgo/respingo acumulam em **y baixo**;
 *   - desbotamento de sol e poeira seca em **y alto**;
 *   - escorrimento de chuva corre de y alto para y baixo;
 *   - o canal verde do normal map aponta para +y do buffer = +v (convenção OpenGL,
 *     que é a que o Three.js usa). Não inverta.
 *
 * ## Geração
 * Os loops escrevem direto em typed arrays e as texturas nascem de `DataTexture`.
 * Isso é equivalente a `OffscreenCanvas` + `ImageData` porém sem a cópia extra pelo
 * canvas 2D. O caminho por canvas existe em `paraCanvas()` e é usado só pela página
 * de teste, que precisa mostrar os mapas lado a lado.
 */

import * as THREE from 'three';
import {
  clamp01, clamp, wrapi, smoothstep,
  perlin2, fbm2n, fbmValor2, ridged2, worley2, worleyFbm, riscosVerticais, fbmWarp,
} from './noise.js';

/** Cria um canvas fora de tela (com fallback para DOM). Só usado para previews. */
export function criarCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** Orçamento de tempo por fatia antes de devolver o thread ao navegador (ms). */
const FATIA_MS = 16;

/**
 * Frequências (repetições por lado) com que cada campo do banco foi assado.
 * Os geradores pedem uma escala INTEIRA de repetição sobre isso — ver `comum.js`.
 */
export const BANCO = {
  grao: 24, graoFino: 96, celular: 12, celF1: 20,
  risco: 40, fbm: 4, mancha: 5, rachas: 10, ridged: 20,
};

export class TextureLab {
  /**
   * @param {object} opts
   * @param {THREE.WebGLRenderer|null} opts.renderer  para descobrir a anisotropia máxima
   * @param {number} opts.anisotropy                   teto desejado (preset de qualidade)
   * @param {boolean} opts.assincrono                  cede o thread entre fatias
   */
  constructor({ renderer = null, anisotropy = 8, assincrono = true } = {}) {
    this.renderer = renderer;
    const max = renderer?.capabilities?.getMaxAnisotropy?.() ?? 16;
    this.anisotropy = Math.max(1, Math.min(anisotropy, max));
    this.assincrono = assincrono;
    this.texturas = [];          // tudo que criamos, para dispose()
    this.det = null;             // banco de detalhes compartilhado (ver prepararBanco)
    this._t0 = 0;
    this._agendar = this._criarAgendador();
    this._pool = new Map();      // reciclagem de Float32Array por tamanho
    this.stats = { bytesGpu: 0, texturas: 0, bancoMs: 0 };
  }

  // -------------------------------------------------------------------------
  // Controle de tempo / cooperação com o navegador
  // -------------------------------------------------------------------------

  marcarInicioFatia() { this._t0 = performance.now(); }

  /**
   * Chame dentro dos loops de linha. Se a fatia estourou o orçamento, devolve o
   * thread ao navegador (mantém a aba responsiva e a barra de carregamento viva).
   *
   * Usa MessageChannel e NÃO setTimeout: a partir do 5º timer aninhado o Chrome
   * aplica um piso de 4 ms por chamada. Com fatias de 16 ms isso custaria 25% do
   * tempo total de geração só esperando.
   */
  async talvezCeder() {
    if (!this.assincrono) return;
    if (performance.now() - this._t0 < FATIA_MS) return;
    await new Promise((r) => this._agendar(r));
    this._t0 = performance.now();
  }

  _criarAgendador() {
    if (typeof MessageChannel === 'undefined') return (fn) => setTimeout(fn, 0);
    const canal = new MessageChannel();
    let pendente = null;
    canal.port1.onmessage = () => { const fn = pendente; pendente = null; fn?.(); };
    return (fn) => { pendente = fn; canal.port2.postMessage(0); };
  }

  // -------------------------------------------------------------------------
  // Banco de detalhes — o truque de performance mais importante daqui
  // -------------------------------------------------------------------------

  /**
   * FBM com domain warping custa ~400 operações por pixel; Worley de 2 oitavas
   * custa ~450. Chamar isso 30 vezes por pixel em 26 superfícies a 1024² dá
   * dezenas de bilhões de operações — foi exatamente o que travou a primeira
   * versão (16 s no preset médio).
   *
   * A solução é a mesma da GPU: **assar uma vez** um punhado de campos de ruído
   * tileáveis e depois só amostrá-los (≈18 operações). Como os campos são
   * periódicos, amostrar com escala INTEIRA mantém a textura final tileável;
   * deslocar a amostragem (ox, oy) equivale a trocar de semente de graça.
   *
   * `n` é potência de dois para o wrap virar um AND.
   */
  async prepararBanco(n = 256) {
    if (this.det && this.det.n === n) return this.det;
    const t0 = performance.now();
    const mask = n - 1;
    const inv = 1 / n;
    const criar = () => new Float32Array(n * n);

    const grao = criar();        // granulação média
    const graoFino = criar();    // poro fino
    const celular = criar();     // agregado (Worley FBM)
    const celF1 = criar();       // distância à célula
    const celId = criar();       // id da célula (constante por célula)
    const celBorda = criar();    // F2−F1 da MESMA grade: 0 na fresta entre células
    const risco = criar();       // ruído esticado em Y (chuva, fibra, escovado)
    const fbm = criar();         // FBM de Perlin genérico
    const mancha = criar();      // FBM com domain warp (manchas orgânicas)
    const rachas = criar();      // arestas de Voronoi (rachaduras)
    const ridged = criar();      // cristas (veios, craquelê)

    const wtmp = new Float32Array(4);

    for (let y = 0; y < n; y++) {
      const v = (y + 0.5) * inv;
      for (let x = 0; x < n; x++) {
        const u = (x + 0.5) * inv;
        const i = y * n + x;

        grao[i] = fbmValor2(u, v, BANCO.grao, 4, 1117);
        graoFino[i] = fbmValor2(u, v, BANCO.graoFino, 2, 2237);
        celular[i] = worleyFbm(u, v, BANCO.celular, 2, 3347);

        worley2(u * BANCO.celF1, v * BANCO.celF1, BANCO.celF1, BANCO.celF1, 4457, wtmp, 0.72);
        celF1[i] = clamp01(wtmp[0] * 1.6);
        celId[i] = wtmp[2];
        celBorda[i] = clamp01((wtmp[1] - wtmp[0]) * 2.4);

        risco[i] = riscosVerticais(u, v, BANCO.risco, 28, 5567, 3);
        fbm[i] = fbm2n(u, v, BANCO.fbm, 5, 6677);
        mancha[i] = fbmWarp(u, v, BANCO.mancha, 4, 7787, 0.5, 2);

        worley2(u * BANCO.rachas, v * BANCO.rachas, BANCO.rachas, BANCO.rachas, 8897, wtmp, 1);
        rachas[i] = clamp01((wtmp[1] - wtmp[0]) * 3.2);   // 0 na aresta, 1 no miolo

        ridged[i] = ridged2(u, v, BANCO.ridged, 4, 9901);
      }
      await this.talvezCeder();
    }

    this.det = {
      n, mask, grao, graoFino, celular, celF1, celId, celBorda, risco, fbm, mancha, rachas, ridged,
    };
    this.stats.bancoMs = Math.round(performance.now() - t0);
    return this.det;
  }

  // -------------------------------------------------------------------------
  // Buffers
  // -------------------------------------------------------------------------

  /** Float32Array w*h, zerado. Reciclado entre gerações para não pressionar o GC. */
  campo(w, h, valorInicial = 0) {
    const n = w * h;
    const livre = this._pool.get(n);
    let a;
    if (livre && livre.length) { a = livre.pop(); } else { a = new Float32Array(n); }
    if (valorInicial === 0) a.fill(0); else a.fill(valorInicial);
    return a;
  }

  /** Devolve um campo ao pool. */
  liberarCampo(a) {
    if (!a) return;
    const lista = this._pool.get(a.length) || [];
    if (lista.length < 6) { lista.push(a); this._pool.set(a.length, lista); }
  }

  /** Uint8ClampedArray RGBA w*h*4. */
  bufferRGBA(w, h) {
    return new Uint8ClampedArray(w * h * 4);
  }

  // -------------------------------------------------------------------------
  // Operações sobre campos escalares
  // -------------------------------------------------------------------------

  /**
   * Borrão separável em caixa, com wrap (mantém tileable). `passes` >= 2 aproxima
   * uma gaussiana. Usa um buffer temporário próprio.
   */
  borrar(campo, w, h, raio, passes = 2) {
    if (raio < 1) return campo;
    const tmp = this.campo(w, h);
    for (let p = 0; p < passes; p++) {
      caixaH(campo, tmp, w, h, raio);   // campo -> tmp
      caixaV(tmp, campo, w, h, raio);   // tmp -> campo (resultado volta ao original)
    }
    this.liberarCampo(tmp);
    return campo;
  }

  /** Normaliza o campo para [0,1] usando min/max reais. */
  normalizar(campo) {
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < campo.length; i++) {
      const v = campo[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    const inv = 1 / (mx - mn || 1);
    for (let i = 0; i < campo.length; i++) campo[i] = (campo[i] - mn) * inv;
    return campo;
  }

  // -------------------------------------------------------------------------
  // Normal map por Sobel
  // -------------------------------------------------------------------------

  /**
   * Deriva o normal map do height por Sobel 3×3 com wrap.
   *
   * `forca` é em unidades de "altura por texel". Para a intensidade ficar coerente
   * entre resoluções diferentes o gradiente é escalado por w/1024 — assim uma parede
   * gerada a 512 e a 2048 tem o mesmo relevo aparente.
   *
   * @returns {Uint8ClampedArray} RGBA (A = 255)
   */
  normalDeAltura(altura, w, h, forca = 1, saida = null) {
    const out = saida || this.bufferRGBA(w, h);
    const escala = forca * (w / 1024);
    for (let y = 0; y < h; y++) {
      const ym = wrapi(y - 1, h) * w;
      const y0 = y * w;
      const yp = wrapi(y + 1, h) * w;
      for (let x = 0; x < w; x++) {
        // Só as duas colunas de borda precisam de wrap; evitar o módulo nos
        // outros 99,8% dos pixels vale ~20% do custo do Sobel.
        const xm = x === 0 ? w - 1 : x - 1;
        const xp = x === w - 1 ? 0 : x + 1;

        const tl = altura[ym + xm], tm = altura[ym + x], tr = altura[ym + xp];
        const ml = altura[y0 + xm], mr = altura[y0 + xp];
        const bl = altura[yp + xm], bm = altura[yp + x], br = altura[yp + xp];

        // Sobel. y cresce para cima em UV (flipY=false), então gy usa (yp − ym).
        const gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
        const gy = (bl + 2 * bm + br) - (tl + 2 * tm + tr);

        let nx = -gx * escala;
        let ny = -gy * escala;
        const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
        nx *= inv; ny *= inv;
        const nz = inv;

        const i = (y0 + x) * 4;
        out[i] = (nx * 0.5 + 0.5) * 255;
        out[i + 1] = (ny * 0.5 + 0.5) * 255;
        out[i + 2] = (nz * 0.5 + 0.5) * 255;
        out[i + 3] = 255;
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // AO por cavidade
  // -------------------------------------------------------------------------

  /**
   * Oclusão ambiente por cavidade: compara o height com uma versão borrada dele.
   * Onde o pixel está **abaixo** da média da vizinhança (junta de tijolo, ranhura,
   * furo) ele fica ocluso. Duas escalas (larga + estreita) porque a oclusão real
   * tem contato de canto E sombreamento de vale.
   *
   * @param {Float32Array} altura  campo [0,1]
   * @param {number} raioLargo     raio em texels da escala macro
   * @param {number} raioFino      raio em texels do contato de canto
   * @param {number} forca         0..2
   * @returns {Float32Array} AO em [0,1] (1 = totalmente aberto)
   */
  aoPorCavidade(altura, w, h, raioLargo = 12, raioFino = 3, forca = 1) {
    const largo = this.campo(w, h);
    const fino = this.campo(w, h);
    largo.set(altura);
    fino.set(altura);
    this.borrar(largo, w, h, Math.max(1, Math.round(raioLargo * (w / 1024))), 2);
    this.borrar(fino, w, h, Math.max(1, Math.round(raioFino * (w / 1024))), 1);

    const ao = this.campo(w, h);
    for (let i = 0; i < ao.length; i++) {
      const dLargo = altura[i] - largo[i];   // negativo = vale amplo
      const dFino = altura[i] - fino[i];     // negativo = ranhura estreita
      // Só a parte negativa oclui; a positiva vira um leve realce de quina (cavity light).
      const oclui = Math.min(0, dLargo) * 2.2 + Math.min(0, dFino) * 3.4;
      const realce = Math.max(0, dLargo) * 0.35;
      ao[i] = clamp01(1 + (oclui + realce) * forca);
    }
    this.liberarCampo(largo);
    this.liberarCampo(fino);
    return ao;
  }

  // -------------------------------------------------------------------------
  // Empacotamento ORM (R=AO, G=Roughness, B=Metalness) — convenção glTF
  // -------------------------------------------------------------------------

  /**
   * Empacota três campos escalares num RGBA. Three.js lê aoMap.r, roughnessMap.g e
   * metalnessMap.b, então a MESMA textura serve para os três slots.
   */
  empacotarORM(ao, rough, metal, w, h) {
    const out = this.bufferRGBA(w, h);
    const n = w * h;
    const metalConst = typeof metal === 'number' ? metal : null;
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      out[j] = (ao ? ao[i] : 1) * 255;
      out[j + 1] = rough[i] * 255;
      out[j + 2] = (metalConst !== null ? metalConst : metal[i]) * 255;
      out[j + 3] = 255;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Redução (box 2×2) — mapas de dados em metade da resolução do albedo
  // -------------------------------------------------------------------------

  /** Reduz um RGBA pela metade com filtro caixa. Repetir para /4, /8… */
  reduzirRGBA(src, w, h) {
    const w2 = w >> 1, h2 = h >> 1;
    const out = new Uint8ClampedArray(w2 * h2 * 4);
    for (let y = 0; y < h2; y++) {
      const s0 = (y * 2) * w, s1 = (y * 2 + 1) * w;
      for (let x = 0; x < w2; x++) {
        const a = (s0 + x * 2) * 4, b = (s0 + x * 2 + 1) * 4;
        const c = (s1 + x * 2) * 4, d = (s1 + x * 2 + 1) * 4;
        const o = (y * w2 + x) * 4;
        out[o] = (src[a] + src[b] + src[c] + src[d]) * 0.25;
        out[o + 1] = (src[a + 1] + src[b + 1] + src[c + 1] + src[d + 1]) * 0.25;
        out[o + 2] = (src[a + 2] + src[b + 2] + src[c + 2] + src[d + 2]) * 0.25;
        out[o + 3] = 255;
      }
    }
    return out;
  }

  /**
   * Renormaliza um normal map RGBA depois de reduzido (a média de normais encurta o
   * vetor; sem isso o relevo some ao baixar a resolução).
   */
  renormalizarNormal(rgba) {
    for (let i = 0; i < rgba.length; i += 4) {
      let x = rgba[i] / 127.5 - 1;
      let y = rgba[i + 1] / 127.5 - 1;
      let z = rgba[i + 2] / 127.5 - 1;
      const len = Math.sqrt(x * x + y * y + z * z) || 1;
      x /= len; y /= len; z /= len;
      rgba[i] = (x * 0.5 + 0.5) * 255;
      rgba[i + 1] = (y * 0.5 + 0.5) * 255;
      rgba[i + 2] = (z * 0.5 + 0.5) * 255;
    }
    return rgba;
  }

  // -------------------------------------------------------------------------
  // Criação de texturas
  // -------------------------------------------------------------------------

  /**
   * @param {Uint8ClampedArray} rgba
   * @param {boolean} srgb  true só para o albedo. Mapas de dados são LINEARES —
   *                        errar isso deixa a cena inteira lavada.
   */
  criarTextura(rgba, w, h, srgb, repeatX = 1, repeatY = 1) {
    const tex = new THREE.DataTexture(
      new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.length),
      w, h, THREE.RGBAFormat, THREE.UnsignedByteType,
    );
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeatX, repeatY);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = this.anisotropy;
    tex.flipY = false;               // DataTexture: linha 0 = v 0 (rodapé)
    tex.needsUpdate = true;

    this.texturas.push(tex);
    this.stats.texturas++;
    this.stats.bytesGpu += Math.round(w * h * 4 * 1.34); // +mipmaps
    return tex;
  }

  /** Desenha um RGBA num canvas (preview da página de teste). */
  paraCanvas(rgba, w, h) {
    const c = criarCanvas(w, h);
    const g = c.getContext('2d');
    const img = g.createImageData(w, h);
    img.data.set(rgba);
    g.putImageData(img, 0, 0);
    return c;
  }

  dispose() {
    for (const t of this.texturas) t.dispose();
    this.texturas.length = 0;
    this._pool.clear();
    this.det = null;
    this.stats.bytesGpu = 0;
    this.stats.texturas = 0;
  }
}

// ---------------------------------------------------------------------------
// Núcleos de borrão em caixa (com wrap). Fora da classe: hot path.
// ---------------------------------------------------------------------------

function caixaH(src, dst, w, h, r) {
  const inv = 1 / (r * 2 + 1);
  for (let y = 0; y < h; y++) {
    const linha = y * w;
    // soma deslizante inicial
    let soma = 0;
    for (let k = -r; k <= r; k++) soma += src[linha + wrapi(k, w)];
    for (let x = 0; x < w; x++) {
      dst[linha + x] = soma * inv;
      soma -= src[linha + wrapi(x - r, w)];
      soma += src[linha + wrapi(x + r + 1, w)];
    }
  }
}

/**
 * Borrão vertical em BLOCOS de colunas.
 *
 * A versão ingênua (coluna por coluna) percorre o array com passo de `w` floats —
 * 4 KB por acesso a 1024². Cada leitura é um cache miss e a passagem vertical
 * chegou a custar mais que o gerador inteiro. Varrendo 64 colunas de uma vez,
 * cada linha tocada são 256 bytes contíguos e o bloco inteiro cabe no cache.
 */
const BLOCO_COL = 64;
const _somaCol = new Float32Array(BLOCO_COL);

function caixaV(src, dst, w, h, r) {
  const inv = 1 / (r * 2 + 1);
  for (let x0 = 0; x0 < w; x0 += BLOCO_COL) {
    const nb = Math.min(BLOCO_COL, w - x0);
    _somaCol.fill(0, 0, nb);
    for (let k = -r; k <= r; k++) {
      const base = wrapi(k, h) * w + x0;
      for (let j = 0; j < nb; j++) _somaCol[j] += src[base + j];
    }
    for (let y = 0; y < h; y++) {
      const o = y * w + x0;
      const bm = wrapi(y - r, h) * w + x0;
      const bp = wrapi(y + r + 1, h) * w + x0;
      for (let j = 0; j < nb; j++) {
        dst[o + j] = _somaCol[j] * inv;
        _somaCol[j] += src[bp + j] - src[bm + j];
      }
    }
  }
}
