/**
 * Aquecimento — compila TODO programa de shader que o jogo vai usar, ainda
 * durante a tela de carregamento.
 * Dono: CORE.
 *
 * ---------------------------------------------------------------------------
 * O DEFEITO QUE ISTO CONSERTA (medido, nao suposto — `tools/pico.mjs`)
 * ---------------------------------------------------------------------------
 * No three.js o programa de um material so e compilado quando aquela
 * COMBINACAO (material + skinning + instancia + luzes + sombra + tonemap +
 * espaco de cor do alvo) entra pela primeira vez no funil de render. Enquanto
 * nenhum hostil esta visivel, nada do hostil foi compilado. No quadro em que a
 * primeira leva aparece, o driver traduz e compila tudo de uma vez, na thread
 * principal — CPU no teto por mais de um segundo, GPU parada.
 *
 * Medido em partida de 179 s a 1280x720, preset alto, GTX 1060:
 *
 *   p50 16,70 ms · p99 24,40 ms · p99.9 36,70 ms
 *   PRIMEIRA entrada de hostil de chao : quadro de **1554,10 ms**, 3 programas novos
 *                                        (depth com skinning + 2x `ai_soldado`)
 *   PRIMEIRA entrada do enxame de drone: quadro de  **655,30 ms**, 1 programa novo
 *                                        (`ai_drone`)
 *   SEGUNDA entrada das mesmas familias: 36,70 ms e 26,80 ms, ZERO programas.
 *
 * "So na primeira vez, e sempre junto com programa novo" e a assinatura de
 * compilacao, e nao a de alocacao nem a de trabalho periodico. As outras duas
 * hipoteses foram medidas e descartadas na mesma corrida: o mapa de ambiente
 * (PMREM a cada 96 quadros) custa no maximo 1,9 ms, e nenhuma coleta de lixo
 * apareceu nos dois quadros ruins.
 *
 * ---------------------------------------------------------------------------
 * POR QUE UM RENDER DE VERDADE, E NAO `renderer.compile()`
 * ---------------------------------------------------------------------------
 * Tres motivos, todos verificaveis na chave de cache do programa:
 *
 * 1. `renderer.compile()` NAO compila o material de profundidade da sombra.
 *    Um dos tres programas do quadro de 1,5 s era exatamente esse (`depth`
 *    com skinning), criado pelo `WebGLShadowMap`, nao pelo passe principal.
 * 2. A chave de cache inclui `toneMapping` e `outputColorSpace`, e os dois
 *    MUDAM conforme o alvo: com PostFX ligado o `Engine` poe
 *    `NoToneMapping` e desenha o mundo num alvo HDR linear. Compilar com o
 *    alvo da tela (sRGB + ACES) produz programa com outra chave — que o jogo
 *    nunca usa, e que nao evita a compilacao de verdade. E por isso que o
 *    pre-aquecimento que ja existia no `FXManager` nao cobria este caso: ele
 *    roda ANTES de o `PostFX` existir (e antes de a IA existir).
 * 3. Um quadro de verdade tambem sobe atributo de instancia, textura e
 *    uniform block — nao so o programa.
 *
 * O metodo: tudo o que hoje esta invisivel (hostil, drone, helice, item, porta,
 * arma guardada) fica visivel e imune ao descarte por frustum por DOIS quadros,
 * com o pipeline real; depois volta exatamente ao estado anterior.
 *
 * `?semaquecer=1` na URL desliga tudo — e o lado "antes" do A/B do
 * `tools/pico.mjs`, e nao existe para outra coisa.
 */

import * as THREE from 'three';

/** Objetos que nao devem ser expostos (nenhum hoje; gancho para quem precisar). */
const IGNORAR = (obj) => obj.userData?.semAquecimento === true;

/**
 * Compila o passe principal em PARALELO, quando o driver deixa.
 *
 * `compileAsync` despacha todos os programas de uma vez e so espera no fim
 * (`KHR_parallel_shader_compile`); o driver usa varios nucleos. Sozinho ele
 * NAO basta — nao cobre o material de profundidade da sombra — e so vale se o
 * estado do renderer for o mesmo do quadro de verdade, porque tonemap e
 * espaco de cor do alvo entram na chave de cache. Por isso o alvo e o tonemap
 * sao os do caminho que o jogo vai usar, e nao os que estiverem por acaso.
 */
async function compilarEmParalelo(ctx) {
  const R = ctx.renderer;
  if (typeof R.compileAsync !== 'function') return false;
  const usaPost = !!(ctx.postfx && ctx.postfx.ready && ctx.postfx.enabled);
  const alvo = usaPost ? (ctx.engine.sceneTarget ?? null) : null;
  const tmAlvo = usaPost ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
  const rtAntes = R.getRenderTarget();
  const tmAntes = R.toneMapping;
  try {
    R.toneMapping = tmAlvo;
    R.setRenderTarget(alvo);
    await R.compileAsync(ctx.scene, ctx.camera);
    if (ctx.viewScene) await R.compileAsync(ctx.viewScene, ctx.viewCamera);
    return true;
  } catch (e) {
    console.warn('[core] compileAsync falhou (segue com o render de verdade):', e);
    return false;
  } finally {
    R.setRenderTarget(rtAntes);
    R.toneMapping = tmAntes;
  }
}

/**
 * @param {object} ctx GameContext ja completo (renderer, cenas, lighting, postfx)
 * @returns {Promise<object>} relatorio {ms, programasAntes, programasDepois, expostos}
 */
export async function aquecerCena(ctx) {
  const R = ctx.renderer;
  const relato = { ms: 0, programasAntes: 0, programasDepois: 0, expostos: 0, ligado: true };
  if (!R || !ctx.engine) return relato;

  try {
    if (typeof location !== 'undefined'
        && new URLSearchParams(location.search).has('semaquecer')) {
      relato.ligado = false;
      relato.programasAntes = relato.programasDepois = R.info.programs?.length ?? 0;
      return relato;
    }
  } catch { /* sem location: segue aquecendo */ }

  const t0 = performance.now();
  relato.programasAntes = R.info.programs?.length ?? 0;

  /* 1. Os defines do CSM precisam estar no material ANTES de ele compilar.
   *    O `Lighting` registra a cena por varredura periodica; um material que
   *    entrou depois da ultima varredura compilaria SEM `USE_CSM` e seria
   *    recompilado no primeiro quadro de jogo — trocando um engasgo por outro. */
  ctx.lighting?.refreshMaterials?.();

  /* 1b. Passe paralelo: a maior parte dos programas sai daqui, com o driver
   *     compilando em varios nucleos em vez de um por quadro. */
  const tPar = performance.now();
  relato.paralelo = await compilarEmParalelo(ctx);
  relato.msParalelo = Math.round(performance.now() - tPar);
  relato.programasAposParalelo = R.info.programs?.length ?? 0;

  /* 2. Expoe o que esta escondido. `frustumCulled = false` e o que garante o
   *    draw call independentemente de onde o objeto esteja: nao e preciso
   *    posicionar nada na frente da camera. */
  const restaurar = [];
  const expor = (raiz) => {
    if (!raiz) return;
    raiz.traverse((obj) => {
      if (IGNORAR(obj)) return;
      const mudou = { obj, visible: obj.visible, frustumCulled: obj.frustumCulled, count: -1 };
      let tocou = false;
      if (obj.visible === false) { obj.visible = true; tocou = true; }
      if (obj.frustumCulled !== false) { obj.frustumCulled = false; tocou = true; }
      /* InstancedMesh com `count = 0` nao gera draw call nenhum, entao o
       * programa dele nao compila. E o caso do lote de helices do enxame
       * (`RotoresEnxame`), que so e preenchido quando ha drone em campo. */
      if (obj.isInstancedMesh && obj.count === 0 && obj.instanceMatrix?.count > 0) {
        mudou.count = 0; obj.count = 1; tocou = true;
      }
      if (tocou) { restaurar.push(mudou); relato.expostos++; }
    });
  };
  expor(ctx.scene);
  expor(ctx.viewScene);
  const vsVisivel = ctx.viewScene?.visible;
  if (ctx.viewScene) ctx.viewScene.visible = true;

  /* 3. Dois quadros com o pipeline REAL (mesmo alvo, mesmo tonemap, mesmas
   *    luzes, mesma cascata de sombra). O primeiro compila; o segundo existe
   *    para que qualquer programa criado tarde no primeiro tambem seja
   *    exercitado antes de a tela de carregamento sair. */
  try {
    ctx.engine.render();
    ctx.engine.render();
  } catch (e) {
    console.warn('[core] aquecimento falhou (o jogo segue, com engasgo no 1o combate):', e);
  }

  /* 4. Devolve tudo ao estado anterior. Ordem inversa por seguranca. */
  for (let i = restaurar.length - 1; i >= 0; i--) {
    const m = restaurar[i];
    m.obj.visible = m.visible;
    m.obj.frustumCulled = m.frustumCulled;
    if (m.count >= 0) m.obj.count = m.count;
  }
  if (ctx.viewScene) ctx.viewScene.visible = vsVisivel;

  relato.programasDepois = R.info.programs?.length ?? 0;
  relato.ms = Math.round(performance.now() - t0);
  return relato;
}

export default aquecerCena;
