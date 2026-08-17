/**
 * MaterialLibrary.js — a biblioteca de materiais do jogo. Dono: MAT.
 *
 * Todo o resto do jogo consome `ctx.materials.get(nome)`. Nada aqui carrega arquivo:
 * cada superfície é gerada por código em `generators/`, com conjunto PBR completo
 * (albedo + normal + AO + roughness + metalness).
 *
 * ## Empacotamento
 * Cada superfície vira **duas** texturas de dados no máximo:
 *   1. `map`        — albedo, RGBA, **SRGBColorSpace**
 *   2. `normalMap`  — normal tangente derivado do height por Sobel, **linear**
 *   3. `orm`        — R=AO, G=Roughness, B=Metalness, **linear**
 * `orm` é ligado simultaneamente em `aoMap`, `roughnessMap` e `metalnessMap`: o
 * Three.js lê exatamente esses canais (convenção glTF), então uma textura serve às três.
 *
 * ## Escala de mundo
 * Cada material sabe quantos metros o seu tile cobre: `material.userData.metros = [x, y]`
 * e `material.userData.escalaUV = [1/x, 1/y]`. Quem gera geometria deve calcular UV em
 * metros e multiplicar por `escalaUV` — assim uma parede de 6 m e uma de 2 m têm tijolos
 * do mesmo tamanho. `repeat` das texturas fica em (1,1) para não brigar com isso.
 *
 * ## Variação por instância
 * `getVariante(nome, i)` devolve um material irmão com deslocamento/espelhamento de UV
 * e tinte levemente diferente, compartilhando a MESMA textura na GPU (Texture.clone()
 * compartilha o `source`). Use em prédios vizinhos para matar a repetição de tiling.
 */

import * as THREE from 'three';
import { TextureLab } from './TextureLab.js';
import { hex } from './generators/comum.js';
import { gerarTijolo, gerarReboco, gerarGrafite, gerarAzulejo } from './generators/alvenaria.js';
import { gerarConcreto, gerarConcretoLiso, gerarAsfalto, gerarCalcadaPortuguesa } from './generators/concreto.js';
import { gerarTelhaBarro, gerarTelhaFibrocimento } from './generators/telhado.js';
import { gerarMetalOndulado, gerarMetalPintado, gerarMetalEscovado } from './generators/metal.js';
import { gerarMadeira, gerarMadeiraPintada } from './generators/madeira.js';
import { gerarTerra, gerarGrama, gerarAgua } from './generators/natural.js';
import { gerarFolha } from './generators/folhagem.js';
import { gerarVidro, gerarPano, gerarBorracha, gerarPlastico } from './generators/diversos.js';

/**
 * Níveis de detalhe. A resolução de cada superfície é
 * `clamp(settings.q.textureSize * escala, min, max)`.
 *
 * ## Por que os tetos existem (decisão consciente, não descuido)
 * Gerar o conjunto PBR é trabalho de CPU. Medido em bancada (Node, máquina ociosa):
 * **0,53 µs por pixel** somando gerador + normal + AO + empacotamento. A 2048² são
 * 4,2 M pixels por superfície ⇒ ~2,2 s cada, ~50 s para as 26. Um FPS não pode
 * gastar quase um minuto de tela de carregamento gerando textura.
 *
 * Com esta tabela o preset **alto** fica em ~5 s e ~75 MB de VRAM. A superfície
 * herói sai a 1024² num tile de 2,4 m = 427 px/m (2,3 mm por texel) — mais
 * resolução do que a tela resolve a qualquer distância jogável. O que o preset alto
 * ganha de fato é anisotropia 16×, que é onde a nitidez aparece em ângulo rasante.
 *
 * Se um dia a geração migrar para a GPU (render target + shader), é só subir os
 * `max`: nenhum gerador precisa mudar.
 */
const TIER = {
  heroi: { escala: 0.50, min: 256, max: 1024 },   // parede que o jogador encosta
  medio: { escala: 0.25, min: 256, max: 512 },
  leve: { escala: 0.125, min: 128, max: 256 },    // pouca área de tela ou pouco detalhe
};
// Resolução resultante por preset:
//   baixo  (512):  herói 256 · médio 256 · leve 128
//   médio  (1024): herói 512 · médio 256 · leve 128
//   alto   (2048): herói 1024 · médio 512 · leve 256
//   ultra  (2048): idem alto (o ganho do ultra é anisotropia e sombra, não textura)

/**
 * Catálogo de superfícies.
 *  gerador  — função async(lab, opts) -> dados PBR
 *  tier     — fração de settings.q.textureSize
 *  metros   — [x, y] cobertos por um tile, em metros de mundo
 *  tipo     — superfície do contrato (FX/AUDIO): concreto|tijolo|metal|madeira|
 *             vidro|terra|asfalto|agua|folhagem
 *  familia  — membros da mesma família compartilham normal/ORM; só o albedo muda
 *  cor      — tinta, para os geradores parametrizáveis
 */
const SUPERFICIES = {
  // --- alvenaria ---
  tijolo: { gerador: gerarTijolo, tier: 'heroi', metros: [2.4, 2.4], tipo: 'tijolo', semente: 1301 },

  reboco: { gerador: gerarReboco, tier: 'heroi', metros: [2.4, 2.4], tipo: 'concreto', familia: 'reboco', semente: 907, cor: hex('#cfc4ad'), descasque: 0.52 },
  reboco_azul: { gerador: gerarReboco, tier: 'heroi', metros: [2.4, 2.4], tipo: 'concreto', familia: 'reboco', semente: 907, cor: hex('#5b93b8'), descasque: 0.40 },
  reboco_amarelo: { gerador: gerarReboco, tier: 'heroi', metros: [2.4, 2.4], tipo: 'concreto', familia: 'reboco', semente: 907, cor: hex('#dfae4e'), descasque: 0.44 },
  reboco_rosa: { gerador: gerarReboco, tier: 'heroi', metros: [2.4, 2.4], tipo: 'concreto', familia: 'reboco', semente: 907, cor: hex('#cf7f83'), descasque: 0.46 },
  reboco_verde: { gerador: gerarReboco, tier: 'heroi', metros: [2.4, 2.4], tipo: 'concreto', familia: 'reboco', semente: 907, cor: hex('#6f9e70'), descasque: 0.42 },

  grafite: { gerador: gerarGrafite, tier: 'medio', metros: [2.4, 2.4], tipo: 'concreto', semente: 5501 },
  azulejo: { gerador: gerarAzulejo, tier: 'leve', metros: [1.2, 1.2], tipo: 'vidro', semente: 8101 },

  // --- concreto e piso ---
  concreto: { gerador: gerarConcreto, tier: 'heroi', metros: [2.0, 2.0], tipo: 'concreto', semente: 2203 },
  concreto_liso: { gerador: gerarConcretoLiso, tier: 'leve', metros: [2.0, 2.0], tipo: 'concreto', semente: 3307 },
  asfalto: { gerador: gerarAsfalto, tier: 'medio', metros: [3.0, 3.0], tipo: 'asfalto', semente: 4409 },
  calcada_portuguesa: { gerador: gerarCalcadaPortuguesa, tier: 'medio', metros: [1.25, 1.25], tipo: 'concreto', semente: 6607 },

  // --- telhado ---
  telha_barro: { gerador: gerarTelhaBarro, tier: 'medio', metros: [1.68, 1.40], tipo: 'tijolo', semente: 7703 },
  telha_fibrocimento: { gerador: gerarTelhaFibrocimento, tier: 'medio', metros: [1.42, 1.40], tipo: 'concreto', semente: 8803 },

  // --- metal ---
  metal_ondulado: { gerador: gerarMetalOndulado, tier: 'medio', metros: [0.92, 0.92], tipo: 'metal', semente: 9901 },
  metal_pintado: { gerador: gerarMetalPintado, tier: 'leve', metros: [1.5, 1.5], tipo: 'metal', semente: 1213, cor: hex('#2f5f4a') },
  metal_escovado: { gerador: gerarMetalEscovado, tier: 'medio', metros: [0.16, 0.16], tipo: 'metal', semente: 1511 },

  // --- madeira ---
  madeira: { gerador: gerarMadeira, tier: 'medio', metros: [1.2, 1.2], tipo: 'madeira', semente: 2417 },
  madeira_pintada: { gerador: gerarMadeiraPintada, tier: 'leve', metros: [1.2, 1.2], tipo: 'madeira', semente: 2917, cor: hex('#3f6f8c') },

  // --- natural ---
  terra: { gerador: gerarTerra, tier: 'medio', metros: [2.5, 2.5], tipo: 'terra', semente: 3119 },
  grama: { gerador: gerarGrama, tier: 'medio', metros: [2.0, 2.0], tipo: 'folhagem', semente: 3719 },
  // Atlas 4x4 de folha COM ALFA. É o material da vegetação em pé (Vegetation.js);
  // `grama` continua sendo o ladrilho de gramado, para chão.
  folha: { gerador: gerarFolha, tier: 'heroi', metros: [1.0, 1.0], tipo: 'folhagem', semente: 5309 },
  agua: { gerador: gerarAgua, tier: 'leve', metros: [3.0, 3.0], tipo: 'agua', semente: 4127 },

  // --- diversos ---
  vidro: { gerador: gerarVidro, tier: 'leve', metros: [1.5, 1.5], tipo: 'vidro', semente: 5227 },
  pano: { gerador: gerarPano, tier: 'leve', metros: [0.35, 0.35], tipo: 'madeira', semente: 6329, cor: hex('#c8503f') },
  borracha: { gerador: gerarBorracha, tier: 'leve', metros: [0.5, 0.5], tipo: 'terra', semente: 7433 },
  plastico: { gerador: gerarPlastico, tier: 'leve', metros: [0.8, 0.8], tipo: 'madeira', semente: 8537, cor: hex('#2f6fa8') },
};

/**
 * ## LEIA ANTES DE CALIBRAR COM `envMapIntensity`
 *
 * Em `three@0.180.0`, `WebGLRenderer.setProgram` faz isto para TODO objeto, em
 * TODO quadro (build/three.module.js, ~linha 17341):
 *
 * ```js
 * if ( material.isMeshStandardMaterial && material.envMap === null && scene.environment !== null )
 *     m_uniforms.envMapIntensity.value = scene.environmentIntensity;
 * ```
 *
 * Ou seja: enquanto o material **não tiver `envMap` próprio**, o valor de
 * `material.envMapIntensity` é sobrescrito pelo global da cena e **não tem
 * efeito nenhum**. Como o jogo usa `scene.environment` (IBL gerado do céu pelo
 * `Lighting`), todos os `envMapIntensity` abaixo estão hoje INERTES.
 *
 * Eles continuam aqui porque registram a intenção autoral, e são copiados para
 * `userData.envFator`. Para torná-los efetivos, chame `aplicarIBL(scene)` —
 * ela atende à condição do `if` dando um `envMap` explícito ao material.
 *
 * **Não calibre nada girando este botão sem antes chamar `aplicarIBL`.** Foi
 * exatamente esse engano que quase levou a compensar no albedo um problema de
 * intensidade de IBL — o que conserta numa hora do dia e estoura em outra.
 */
const AJUSTES = {
  vidro: (m) => { m.transparent = true; m.opacity = 0.42; m.side = THREE.DoubleSide; m.envMapIntensity = 1.6; },
  agua: (m) => { m.transparent = true; m.opacity = 0.94; m.envMapIntensity = 1.4; },
  pano: (m) => { m.side = THREE.DoubleSide; },
  grama: (m) => { m.side = THREE.DoubleSide; },
  /**
   * Folha: recorte BINÁRIO por alphaTest, nunca `transparent`.
   * `transparent:true` obrigaria ordenação por profundidade em ~5 mil instâncias
   * e ainda daria artefato de ordem entre folhas do mesmo tufo. O alphaTest
   * descarta o fragmento antes do blending: custo ~zero e depth correto.
   * O limiar 0,42 é alto o bastante para a borda não virar franja no mip e
   * baixo o bastante para o tufo não sumir a 60 m.
   */
  folha: (m) => {
    m.side = THREE.DoubleSide;
    m.alphaTest = 0.42;
    m.transparent = false;
    m.shadowSide = THREE.DoubleSide;
    m.roughness = 1;
    m.envMapIntensity = 0.85;
  },
  metal_escovado: (m) => { m.envMapIntensity = 1.25; },
  metal_ondulado: (m) => { m.envMapIntensity = 1.1; },
};

/** Ordem de geração: o que aparece mais cedo na tela primeiro. */
const ORDEM = Object.keys(SUPERFICIES);

export class MaterialLibrary {
  constructor(ctx) {
    this.ctx = ctx;
    this.lab = null;
    this.materiais = new Map();       // nome -> MeshStandardMaterial
    this.variantes = new Map();       // "nome#i" -> MeshStandardMaterial
    this.tipoPorMaterial = new WeakMap();
    this.nomePorMaterial = new WeakMap();
    this.stats = { totalMs: 0, bancoMs: 0, mapasMs: 0, porSuperficie: {}, bytesGpu: 0, texturas: 0, preset: null };
    this._pronto = false;
  }

  // -------------------------------------------------------------------------
  // Ciclo de vida
  // -------------------------------------------------------------------------

  async init() {
    const t0 = performance.now();
    const q = this.ctx?.settings?.q ?? { textureSize: 1024, anisotropy: 8 };
    const base = q.textureSize ?? 1024;

    this.lab = new TextureLab({
      renderer: this.ctx?.renderer ?? null,
      anisotropy: q.anisotropy ?? 8,
      assincrono: true,
    });

    // Banco de detalhes compartilhado: assado UMA vez, amostrado por todo mundo.
    // 256² basta: os campos são amostrados com escala inteira, então o detalhe
    // fino sai da escala, não da resolução do banco. Subir para 512 custa 4× o
    // tempo de assar (~2 s) sem ganho visível.
    this.lab.marcarInicioFatia();
    await this.lab.prepararBanco(256);

    const familias = new Map();       // nome da família -> { normalTex, ormTex, reuso, res }
    // Gancho de depuração (test/materials.html): gera só um subconjunto para
    // iterar rápido numa superfície. Nunca usado pelo jogo.
    const filtro = this.ctx?.matFiltro;
    const alvos = filtro?.length ? ORDEM.filter((n) => filtro.includes(n)) : ORDEM;
    const total = alvos.length;
    let feitos = 0;

    for (const nome of alvos) {
      const cfg = SUPERFICIES[nome];
      const t = TIER[cfg.tier];
      const res = Math.min(t.max, Math.max(t.min, Math.round(base * t.escala)));
      // Normal e ORM em metade da resolução do albedo: o olho não percebe a
      // diferença e economiza ~40% da VRAM da superfície.
      const resDados = Math.max(128, res >> 1);

      const tSup = performance.now();
      const fam = cfg.familia ? familias.get(cfg.familia) : null;

      const dados = await cfg.gerador(this.lab, {
        w: res, h: res,
        semente: cfg.semente ?? 1,
        cor: cfg.cor,
        descasque: cfg.descasque,
        reuso: fam?.reuso ?? null,
      });

      const tGer = performance.now();
      const mat = this._montarMaterial(nome, cfg, dados, res, resDados, fam);
      this.stats.mapasMs += performance.now() - tGer;

      // O primeiro membro de uma família guarda os mapas de dados para os irmãos.
      if (cfg.familia && !fam) {
        familias.set(cfg.familia, {
          normalTex: mat.normalMap,
          ormTex: mat.roughnessMap,
          reuso: dados.reuso ?? null,
          res,
        });
      }

      this.stats.porSuperficie[nome] = Math.round(performance.now() - tSup);
      feitos++;
      this._progresso(nome, feitos / total);
    }

    this.stats.totalMs = Math.round(performance.now() - t0);
    this.stats.bytesGpu = this.lab.stats.bytesGpu;
    this.stats.texturas = this.lab.stats.texturas;
    this.stats.preset = q.name ?? '?';
    this._pronto = true;

    this.stats.bancoMs = this.lab.stats.bancoMs;
    this.stats.mapasMs = Math.round(this.stats.mapasMs);
    console.info(
      `[MAT] ${this.materiais.size} superfícies em ${this.stats.totalMs} ms ` +
      `(banco ${this.stats.bancoMs} ms, preset ${this.stats.preset}, base ${base}px, ` +
      `${this.stats.texturas} texturas, ~${(this.stats.bytesGpu / 1048576).toFixed(0)} MB de VRAM)`,
    );
    return this;
  }

  /** Monta as texturas e o MeshStandardMaterial de uma superfície. */
  _montarMaterial(nome, cfg, dados, res, resDados, fam) {
    const lab = this.lab;
    const { w, h, albedo, altura, rugosidade, metalico } = dados;

    // --- albedo ---
    const texAlbedo = lab.criarTextura(albedo, w, h, true);

    let texNormal, texOrm;
    if (fam) {
      // Irmão de família: herda normal e ORM (mesma geometria de superfície).
      texNormal = fam.normalTex;
      texOrm = fam.ormTex;
    } else {
      // --- normal por Sobel a partir do height ---
      let normalRGBA = lab.normalDeAltura(altura, w, h, dados.normalForca ?? 1.5);
      // --- AO por cavidade ---
      const ao = dados.aoExtra
        ? dados.aoExtra
        : lab.aoPorCavidade(altura, w, h, dados.aoRaioLargo ?? 12, dados.aoRaioFino ?? 3, dados.aoForca ?? 1);
      let ormRGBA = lab.empacotarORM(ao, rugosidade, metalico, w, h);
      lab.liberarCampo(ao);

      // Mapas de dados em metade da resolução do albedo: o olho não percebe e
      // corta ~40% da VRAM. O normal precisa ser renormalizado após a média.
      let wd = w, hd = h;
      while (wd > resDados) {
        normalRGBA = lab.reduzirRGBA(normalRGBA, wd, hd);
        ormRGBA = lab.reduzirRGBA(ormRGBA, wd, hd);
        wd >>= 1; hd >>= 1;
      }
      lab.renormalizarNormal(normalRGBA);

      texNormal = lab.criarTextura(normalRGBA, wd, hd, false);
      texOrm = lab.criarTextura(ormRGBA, wd, hd, false);
    }

    // Campos de família continuam vivos enquanto houver irmãos por gerar; os
    // demais voltam ao pool imediatamente.
    if (!cfg.familia) {
      lab.liberarCampo(altura);
      lab.liberarCampo(rugosidade);
    }
    lab.liberarCampo(metalico);

    // --- material ---
    const props = dados.props ?? {};
    const mat = new THREE.MeshStandardMaterial({
      name: nome,
      map: texAlbedo,
      normalMap: texNormal,
      normalScale: new THREE.Vector2(props.normalEscala ?? 1, props.normalEscala ?? 1),
      // ORM: os três slots apontam para a mesma textura; o Three lê .r/.g/.b.
      aoMap: texOrm,
      aoMapIntensity: 1,
      roughnessMap: texOrm,
      roughness: 1,
      metalnessMap: texOrm,
      metalness: 1,
      envMapIntensity: 1,
      dithering: true,
    });
    if (props.doisLados) mat.side = THREE.DoubleSide;
    AJUSTES[nome]?.(mat);

    // Fator de IBL pretendido pelo autor. Guardado separado porque
    // `envMapIntensity` é sobrescrito pelo renderer enquanto não houver
    // `envMap` próprio — ver o bloco de comentário acima de AJUSTES.
    mat.userData.envFator = mat.envMapIntensity;
    mat.userData.superficie = cfg.tipo;
    mat.userData.nome = nome;
    mat.userData.metros = cfg.metros.slice();
    mat.userData.escalaUV = [1 / cfg.metros[0], 1 / cfg.metros[1]];
    mat.userData.resolucao = res;

    this.materiais.set(nome, mat);
    this.tipoPorMaterial.set(mat, cfg.tipo);
    this.nomePorMaterial.set(mat, nome);
    return mat;
  }

  _progresso(nome, frac) {
    // main.js reserva a faixa 0.05–0.25 da barra de boot para os materiais.
    this.ctx?.bus?.emit?.('boot:progress', {
      label: `Gerando materiais (${nome})`,
      pct: 0.05 + frac * 0.19,
    });
  }

  // -------------------------------------------------------------------------
  // API pública
  // -------------------------------------------------------------------------

  /**
   * @param {string} nome
   * @returns {THREE.MeshStandardMaterial} material compartilhado (não modifique!)
   */
  get(nome) {
    const m = this.materiais.get(nome);
    if (m) return m;
    console.warn(`[MAT] superfície desconhecida: "${nome}" — usando 'concreto'`);
    return this.materiais.get('concreto') ?? this._fallback();
  }

  /**
   * Variante de instância: mesmas texturas na GPU, UV deslocada/espelhada e um
   * tinte levemente diferente. Use para prédios vizinhos não ficarem idênticos.
   * @param {string} nome
   * @param {number} i  índice da variante (0..3); qualquer inteiro é aceito
   */
  getVariante(nome, i = 0) {
    const idx = ((i | 0) % 4 + 4) % 4;
    if (idx === 0) return this.get(nome);
    const chave = `${nome}#${idx}`;
    const cache = this.variantes.get(chave);
    if (cache) return cache;

    const base = this.get(nome);
    const mat = base.clone();
    mat.name = chave;

    // Deslocamento e espelhamento de UV por variante. Espelhar em X mantém o tile
    // válido (o ruído é periódico) e quebra a percepção de repetição.
    const desl = [[0, 0], [0.5, 0.31], [0.17, 0.63], [0.71, 0.11]][idx];
    const espelho = (idx & 1) ? -1 : 1;
    for (const chaveTex of ['map', 'normalMap', 'aoMap', 'roughnessMap', 'metalnessMap']) {
      const t = base[chaveTex];
      if (!t) continue;
      const c = t.clone();          // compartilha o Source ⇒ zero VRAM extra
      c.offset.set(desl[0], desl[1]);
      c.repeat.set(espelho, 1);
      c.needsUpdate = true;
      mat[chaveTex] = c;
    }
    // Tinte sutil (±6%) para o olho não casar duas paredes vizinhas
    const t = 1 + ((idx * 0.037) % 0.12) - 0.06;
    mat.color.setRGB(t, t * 0.995, t * 0.99);

    mat.userData = { ...base.userData, variante: idx };
    this.variantes.set(chave, mat);
    this.tipoPorMaterial.set(mat, base.userData.superficie);
    this.nomePorMaterial.set(mat, nome);
    return mat;
  }

  /**
   * Superfície do contrato (para FX escolher decal e AUDIO escolher som).
   * @returns {'concreto'|'tijolo'|'metal'|'madeira'|'vidro'|'terra'|'asfalto'|'agua'|'folhagem'}
   */
  getSurfaceType(material) {
    if (!material) return 'concreto';
    if (Array.isArray(material)) return this.getSurfaceType(material[0]);
    return this.tipoPorMaterial.get(material) ?? material.userData?.superficie ?? 'concreto';
  }

  /** Nome interno exato da superfície ('reboco_azul', 'telha_barro'…). */
  getNomeSuperficie(material) {
    if (!material) return null;
    if (Array.isArray(material)) return this.getNomeSuperficie(material[0]);
    return this.nomePorMaterial.get(material) ?? material.userData?.nome ?? null;
  }

  /** Metros cobertos por um tile: use para gerar UV em escala de mundo. */
  escalaUV(nome) {
    const m = this.materiais.get(nome);
    return m ? m.userData.escalaUV : [1, 1];
  }

  /**
   * Torna `userData.envFator` efetivo de verdade.
   *
   * O renderer só respeita `material.envMapIntensity` se o material tiver
   * `envMap` próprio (ver o comentário acima de AJUSTES). Esta função aponta o
   * `envMap` de cada material para o IBL da cena e reescreve a intensidade como
   * `envFator * scene.environmentIntensity`, preservando a escala global.
   * Custo de shader: zero — é o mesmo `USE_ENVMAP` que já estava ligado.
   *
   * **Precisa ser rechamada toda vez que o IBL for regerado** (o `Lighting`
   * recria o PMREM quando o céu muda de hora). Se não for, os materiais ficam
   * segurando um render target antigo — que pode já ter sido descartado.
   * Por isso ela é idempotente e barata: chamar demais não custa nada.
   *
   * @param {THREE.Scene} scene cena cujo `environment` é o IBL corrente
   * @returns {number} quantos materiais foram sincronizados
   */
  aplicarIBL(scene) {
    const env = scene?.environment ?? null;
    if (!env) return 0;
    const escala = scene.environmentIntensity ?? 1;
    let n = 0;
    const sincronizar = (m) => {
      const fator = m.userData?.envFator ?? 1;
      const alvo = fator * escala;
      if (m.envMap === env && m.envMapIntensity === alvo) return;
      m.envMap = env;
      m.envMapIntensity = alvo;
      m.needsUpdate = true;
      n++;
    };
    for (const m of this.materiais.values()) sincronizar(m);
    for (const m of this.variantes.values()) sincronizar(m);
    return n;
  }

  /** Lista de todas as superfícies disponíveis. */
  nomes() { return [...this.materiais.keys()]; }

  get pronto() { return this._pronto; }

  /** Regeneração completa (chamado quando o preset de qualidade muda). */
  async setQuality() {
    if (!this._pronto) return;
    const antigos = new Map(this.materiais);
    this.materiais.clear();
    this.variantes.clear();
    const labAntigo = this.lab;
    this.stats = { totalMs: 0, bancoMs: 0, mapasMs: 0, porSuperficie: {}, bytesGpu: 0, texturas: 0, preset: null };
    await this.init();
    // Os materiais antigos ainda estão referenciados pelas malhas do mundo; só o
    // WORLD pode trocá-los. Liberamos apenas as texturas antigas depois que ele avisar.
    this.ctx?.bus?.emit?.('materials:rebuilt', { antigos, novos: this.materiais });
    labAntigo?.dispose();
    for (const m of antigos.values()) m.dispose();
  }

  dispose() {
    for (const m of this.variantes.values()) m.dispose();
    for (const m of this.materiais.values()) m.dispose();
    this.variantes.clear();
    this.materiais.clear();
    this.lab?.dispose();
    this.lab = null;
    this._pronto = false;
  }

  _fallback() {
    const m = new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 0.9, name: 'fallback' });
    this.materiais.set('__fallback', m);
    return m;
  }
}
