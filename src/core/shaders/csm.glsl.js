/**
 * Patches globais de ShaderChunk para Cascaded Shadow Maps + filtro Poisson/PCSS.
 * Dono: CORE.
 *
 * Por que patch global e nao um material custom?
 *   O `Lighting` precisa que TODO material do mundo (gerados pelo modulo MAT,
 *   que nao podemos editar) enxergue as cascatas. Sobrescrever os chunks
 *   `lights_fragment_begin` / `lights_pars_begin` / `shadowmap_pars_fragment`
 *   e o unico ponto de extensao do three que alcanca os materiais built-in sem
 *   tocar em arquivo de outro modulo.
 *
 * Estrategia:
 *   - O corpo do CSM (selecao de cascata + blend) vem do addon oficial
 *     `three/addons/csm/CSMShader.js`, que ja acompanha o pacote `three` (nao e
 *     dependencia nova) e esta garantidamente em sincronia com os demais chunks
 *     da versao instalada.
 *   - Trocamos a chamada `getShadow(...)` pela nossa `getShadowCSM(...)`, que
 *     faz PCF com disco de Poisson rotacionado por pixel + busca de bloqueador
 *     (PCSS barato) para penumbra que endurece no contato.
 */
import { ShaderChunk } from 'three';
import { CSMShader } from 'three/addons/csm/CSMShader.js';

// Guardamos os originais para poder desfazer em dispose().
const ORIGINAL = {
  lights_fragment_begin: ShaderChunk.lights_fragment_begin,
  lights_pars_begin: ShaderChunk.lights_pars_begin,
  shadowmap_pars_fragment: ShaderChunk.shadowmap_pars_fragment,
};

/**
 * Filtro de sombra. Injetado DENTRO do bloco `#ifdef USE_SHADOWMAP` do chunk
 * original (precisa de `texture2DCompare` e `unpackRGBAToDepth`).
 *
 * Notas de qualidade:
 *  - 16 taps em disco de Poisson, rotacionados por um Interleaved Gradient
 *    Noise dependente de gl_FragCoord: troca banding em degraus por um ruido
 *    fino que o TAA/FXAA dissolve.
 *  - Receiver-plane depth bias: o bias correto para cada tap depende da
 *    inclinacao da superficie no espaco da sombra. Sem ele, ou se ve acne em
 *    rampas ou se ve peter-panning em paredes.
 *  - PCSS barato (OCA_PCSS): uma busca de bloqueador de 8 taps estima a
 *    largura da penumbra; sombra de contato fica dura, sombra distante macia.
 */
const SHADOW_FILTER = /* glsl */`

// --- CORE: filtro de sombra Poisson/PCSS -----------------------------------

// Disco de Poisson de 16 pontos (distribuicao classica, raio 1).
const vec2 OCA_POISSON[16] = vec2[16](
  vec2( -0.94201624, -0.39906216 ), vec2(  0.94558609, -0.76890725 ),
  vec2( -0.09418410, -0.92938870 ), vec2(  0.34495938,  0.29387760 ),
  vec2( -0.91588581,  0.45771432 ), vec2( -0.81544232, -0.87912464 ),
  vec2( -0.38277543,  0.27676845 ), vec2(  0.97484398,  0.75648379 ),
  vec2(  0.44323325, -0.97511554 ), vec2(  0.53742981, -0.47373420 ),
  vec2( -0.26496911, -0.41893023 ), vec2(  0.79197514,  0.19090188 ),
  vec2( -0.24188840,  0.99706507 ), vec2( -0.81409955,  0.91437590 ),
  vec2(  0.19984126,  0.78641367 ), vec2(  0.14383161, -0.14100790 )
);

float ocaShadowTap( sampler2D shadowMap, vec2 base, vec2 offset, float z, vec2 planeBias ) {
  float dz = clamp( dot( offset, planeBias ), -0.0035, 0.0035 );
  return texture2DCompare( shadowMap, base + offset, z + dz );
}

float getShadowCSM( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {

  vec3 sc = shadowCoord.xyz / shadowCoord.w;

  // Derivadas ANTES de qualquer branch: dFdx em fluxo nao-uniforme e indefinido.
  vec3 ddx = dFdx( sc );
  vec3 ddy = dFdy( sc );
  vec2 planeBias = vec2( 0.0 );
  float det = ddx.x * ddy.y - ddx.y * ddy.x;
  if ( abs( det ) > 1e-9 ) {
    planeBias = vec2( ddy.y * ddx.z - ddx.y * ddy.z,
                      ddx.x * ddy.z - ddy.x * ddx.z ) / det;
    planeBias = clamp( planeBias, vec2( -8.0 ), vec2( 8.0 ) );
  }

  bool inFrustum = sc.x >= 0.0 && sc.x <= 1.0 && sc.y >= 0.0 && sc.y <= 1.0 && sc.z <= 1.0;
  if ( ! inFrustum ) return 1.0;

  float z = sc.z + shadowBias;
  vec2 texel = 1.0 / shadowMapSize;

  // Rotacao pseudo-aleatoria estavel no espaco de tela.
  float ign = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
  float ang = ign * PI2;
  float cs = cos( ang ), sn = sin( ang );
  mat2 rot = mat2( cs, sn, -sn, cs );

  float radius = max( shadowRadius, 0.5 );

#ifdef OCA_PCSS
  // --- 1) Busca de bloqueador: quao longe esta o oclusor? -------------------
  float searchR = radius * 4.0;
  float blockerDepth = 0.0;
  float blockerCount = 0.0;
  for ( int i = 0; i < 8; i++ ) {
    vec2 o = rot * OCA_POISSON[ i * 2 ] * searchR * texel;
    float d = unpackRGBAToDepth( texture2D( shadowMap, sc.xy + o ) );
    if ( d < z ) { blockerDepth += d; blockerCount += 1.0; }
  }
  if ( blockerCount < 0.5 ) return 1.0;   // nada bloqueando: totalmente aceso
  float avgBlocker = blockerDepth / blockerCount;
  // Penumbra proporcional a distancia receptor-bloqueador (semelhanca de triangulos).
  float penumbra = ( z - avgBlocker ) / max( avgBlocker, 1e-4 );
  radius = clamp( radius * ( 1.0 + penumbra * 18.0 ), radius, radius * 3.0 );
#endif

  vec2 scale = radius * texel;
  float sum = 0.0;
  sum += ocaShadowTap( shadowMap, sc.xy, rot * OCA_POISSON[ 0 ] * scale, z, planeBias );
  sum += ocaShadowTap( shadowMap, sc.xy, rot * OCA_POISSON[ 1 ] * scale, z, planeBias );
  sum += ocaShadowTap( shadowMap, sc.xy, rot * OCA_POISSON[ 2 ] * scale, z, planeBias );
  sum += ocaShadowTap( shadowMap, sc.xy, rot * OCA_POISSON[ 3 ] * scale, z, planeBias );
  sum += ocaShadowTap( shadowMap, sc.xy, rot * OCA_POISSON[ 4 ] * scale, z, planeBias );
  sum += ocaShadowTap( shadowMap, sc.xy, rot * OCA_POISSON[ 5 ] * scale, z, planeBias );
  sum += ocaShadowTap( shadowMap, sc.xy, rot * OCA_POISSON[ 6 ] * scale, z, planeBias );
  sum += ocaShadowTap( shadowMap, sc.xy, rot * OCA_POISSON[ 7 ] * scale, z, planeBias );
#ifndef OCA_SHADOW_CHEAP
  sum += ocaShadowTap( shadowMap, sc.xy, rot * OCA_POISSON[ 8 ] * scale, z, planeBias );
  sum += ocaShadowTap( shadowMap, sc.xy, rot * OCA_POISSON[ 9 ] * scale, z, planeBias );
  sum += ocaShadowTap( shadowMap, sc.xy, rot * OCA_POISSON[ 10 ] * scale, z, planeBias );
  sum += ocaShadowTap( shadowMap, sc.xy, rot * OCA_POISSON[ 11 ] * scale, z, planeBias );
  sum += ocaShadowTap( shadowMap, sc.xy, rot * OCA_POISSON[ 12 ] * scale, z, planeBias );
  sum += ocaShadowTap( shadowMap, sc.xy, rot * OCA_POISSON[ 13 ] * scale, z, planeBias );
  sum += ocaShadowTap( shadowMap, sc.xy, rot * OCA_POISSON[ 14 ] * scale, z, planeBias );
  sum += ocaShadowTap( shadowMap, sc.xy, rot * OCA_POISSON[ 15 ] * scale, z, planeBias );
  sum *= 0.0625;
#else
  sum *= 0.125;
#endif

  // Fade nas bordas do mapa da cascata: evita a "parede" de sombra quando o
  // fragmento sai do frustum ortografico da cascata.
  vec2 fadeUv = abs( sc.xy - 0.5 ) * 2.0;
  float edge = 1.0 - smoothstep( 0.86, 1.0, max( fadeUv.x, fadeUv.y ) );
  sum = mix( 1.0, sum, edge );

  return mix( 1.0, sum, shadowIntensity );
}
`;

let installed = false;

/**
 * Aplica os patches. Idempotente.
 * Deve ser chamado ANTES de qualquer material ser compilado (i.e. no init do
 * Lighting, que roda antes do World).
 */
export function installCSMChunks() {
  if (installed) return;
  installed = true;

  // 1) Filtro de sombra: injetado antes do `#endif` final do chunk original,
  //    que fecha o `#ifdef USE_SHADOWMAP`.
  const src = ORIGINAL.shadowmap_pars_fragment;
  const cut = src.lastIndexOf('#endif');
  ShaderChunk.shadowmap_pars_fragment =
    src.slice(0, cut) + SHADOW_FILTER + '\n' + src.slice(cut);

  // 2) Selecao/blend de cascatas + troca do filtro.
  ShaderChunk.lights_fragment_begin =
    CSMShader.lights_fragment_begin.replace(/getShadow\(/g, 'getShadowCSM(');

  // 3) Uniforms das cascatas (CSM_cascades, cameraNear, shadowFar).
  ShaderChunk.lights_pars_begin = CSMShader.lights_pars_begin;
}

/** Restaura os chunks originais do three. */
export function uninstallCSMChunks() {
  if (!installed) return;
  installed = false;
  ShaderChunk.lights_fragment_begin = ORIGINAL.lights_fragment_begin;
  ShaderChunk.lights_pars_begin = ORIGINAL.lights_pars_begin;
  ShaderChunk.shadowmap_pars_fragment = ORIGINAL.shadowmap_pars_fragment;
}
