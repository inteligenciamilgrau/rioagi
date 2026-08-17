/**
 * Fragment shaders da cadeia de pos-processamento.
 * Dono: CORE. Ordem da cadeia (contrato do ARCHITECTURE.md):
 *   SSAO -> Bloom -> Motion Blur -> DOF -> Tonemap+Grade -> TAA/FXAA -> Grain/Vinheta/CA
 *
 * Convencao de canal alpha no buffer HDR:
 *   a = 0.0  -> pixel do MUNDO   (recebe motion blur / DOF)
 *   a = 1.0  -> pixel do VIEWMODEL (arma) — sempre nitido e sem borrao
 * A mascara nasce de graca: o composite de AO grava alpha 0 e o render do
 * viewmodel por cima grava alpha 1 (MeshStandardMaterial sempre emite a=1).
 */
import { GLSL_MATH, GLSL_HASH, GLSL_DEPTH, GLSL_TONEMAP, glsl } from './common.glsl.js';

/* ========================================================================== */
/* 0. Utilitario                                                               */
/* ========================================================================== */

export const COPY_FRAG = /* glsl */`
varying vec2 vUv;
uniform sampler2D tSrc;
void main() { gl_FragColor = texture2D( tSrc, vUv ); }
`;

/* ========================================================================== */
/* 1. Normal + profundidade linear em meia resolucao                           */
/* ========================================================================== */
/**
 * Nao usamos MRT nem pre-passe de geometria: o depth buffer da cena ja vem de
 * graca (DepthTexture anexada ao alvo HDR) e a normal e reconstruida dele.
 * Custo: 1 draw call de meia-res em vez de duplicar todas as draw calls do mundo.
 * A reconstrucao usa o vizinho de menor diferenca de profundidade em cada eixo,
 * o que preserva silhuetas (a versao ingenua com dFdx cria "abas" nas bordas).
 */
export const NORMAL_DEPTH_FRAG = glsl(GLSL_MATH, GLSL_DEPTH, /* glsl */`
varying vec2 vUv;
uniform sampler2D tDepth;
uniform vec2  uInvProjParams;
uniform vec2  uTexel;      // 1 / resolucao de meia-res
uniform float uNear;
uniform float uFar;

float linZ( vec2 uv ) {
  return linearizeDepth( texture2D( tDepth, uv ).x, uNear, uFar );
}

void main() {
  float z = linZ( vUv );
  vec3 P = viewPosFromLinear( vUv, z, uInvProjParams );

  vec2 ex = vec2( uTexel.x, 0.0 );
  vec2 ey = vec2( 0.0, uTexel.y );

  float zl = linZ( vUv - ex ), zr = linZ( vUv + ex );
  float zd = linZ( vUv - ey ), zu = linZ( vUv + ey );

  vec3 dx = ( abs( zr - z ) < abs( zl - z ) )
    ? ( viewPosFromLinear( vUv + ex, zr, uInvProjParams ) - P )
    : ( P - viewPosFromLinear( vUv - ex, zl, uInvProjParams ) );
  vec3 dy = ( abs( zu - z ) < abs( zd - z ) )
    ? ( viewPosFromLinear( vUv + ey, zu, uInvProjParams ) - P )
    : ( P - viewPosFromLinear( vUv - ey, zd, uInvProjParams ) );

  vec3 n = cross( dx, dy );
  float len = length( n );
  n = ( len > 1e-9 ) ? n / len : vec3( 0.0, 0.0, 1.0 );
  if ( n.z < 0.0 ) n = -n;   // sempre virada para a camera

  gl_FragColor = vec4( n, z );
}
`);

/* ========================================================================== */
/* 2. GTAO — Ground Truth Ambient Occlusion                                    */
/* ========================================================================== */
/**
 * Horizon-based com o integral de arco cosseno-ponderado do paper do Jimenez
 * (SIGGRAPH 2016). Diferente do SSAO ingenuo (amostras em hemisferio + step),
 * o GTAO resolve a visibilidade analiticamente por fatia, o que da oclusao de
 * contato limpa e sem "halo" ao redor de objetos.
 * Roda em meia resolucao; o ruido restante e dissolvido pelo blur bilateral.
 */
export const GTAO_FRAG = glsl(GLSL_MATH, GLSL_DEPTH, /* glsl */`
varying vec2 vUv;
uniform sampler2D tND;          // rgb = normal de vista, a = profundidade linear
uniform vec2  uInvProjParams;
uniform vec2  uResolution;      // resolucao de meia-res
uniform float uRadius;          // raio de busca em metros
uniform float uProjScale;       // metros -> pixels a 1m de distancia
uniform float uIntensity;
uniform float uFar;
uniform float uFrame;

#ifndef SLICES
#define SLICES 3
#endif
#ifndef STEPS
#define STEPS 5
#endif

void main() {
  vec4 nd = texture2D( tND, vUv );
  float z = nd.a;

  // Ceu / fora de alcance: sem oclusao.
  if ( z >= uFar * 0.98 ) { gl_FragColor = vec4( 1.0 ); return; }

  vec3 P = viewPosFromLinear( vUv, z, uInvProjParams );
  vec3 N = normalize( nd.xyz );
  vec3 V = normalize( -P );

  // Interleaved Gradient Noise + rotacao temporal (o TAA resolve o resto).
  float ign = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
  float noiseDir = fract( ign + uFrame * 0.6180339887 );
  float noiseOff = fract( ign * 3.1 + uFrame * 0.4142135624 );

  // Raio em pixels: converte o raio de mundo para tela nesta profundidade.
  float radiusPx = clamp( uProjScale * uRadius / z, 3.0, 96.0 );
  float visibility = 0.0;

  for ( int s = 0; s < SLICES; s++ ) {

    float phi = ( float( s ) + noiseDir ) * PI / float( SLICES );
    vec2 omega = vec2( cos( phi ), sin( phi ) );

    vec3 dirV = vec3( omega, 0.0 );
    vec3 ortho = dirV - dot( dirV, V ) * V;
    vec3 axis = normalize( cross( dirV, V ) );
    vec3 projN = N - axis * dot( N, axis );
    float projNlen = length( projN );
    if ( projNlen < 1e-4 ) continue;
    vec3 projNn = projN / projNlen;

    float cosN = clamp( dot( projNn, V ), -1.0, 1.0 );
    float gamma = sign( dot( ortho, projNn ) ) * acos( cosN );

    // Horizontes nos dois sentidos da fatia.
    float cosHneg = -1.0;
    float cosHpos = -1.0;

    for ( int t = 0; t < STEPS; t++ ) {
      float frac = ( float( t ) + noiseOff ) / float( STEPS );
      // Distribuicao quadratica: mais amostras perto do centro (contato).
      float px = max( frac * frac * radiusPx, 1.5 );
      vec2 off = omega * px / uResolution;

      // sentido negativo
      float zs = texture2D( tND, vUv - off ).a;
      vec3 dS = viewPosFromLinear( vUv - off, zs, uInvProjParams ) - P;
      float dist = length( dS );
      if ( dist > 1e-4 ) {
        float fall = clamp( 1.0 - ( dist - uRadius ) / max( uRadius * 0.5, 1e-3 ), 0.0, 1.0 );
        cosHneg = max( cosHneg, mix( -1.0, dot( dS / dist, V ), fall ) );
      }

      // sentido positivo
      zs = texture2D( tND, vUv + off ).a;
      dS = viewPosFromLinear( vUv + off, zs, uInvProjParams ) - P;
      dist = length( dS );
      if ( dist > 1e-4 ) {
        float fall = clamp( 1.0 - ( dist - uRadius ) / max( uRadius * 0.5, 1e-3 ), 0.0, 1.0 );
        cosHpos = max( cosHpos, mix( -1.0, dot( dS / dist, V ), fall ) );
      }
    }

    float h1 = -acos( clamp( cosHneg, -1.0, 1.0 ) );
    float h2 =  acos( clamp( cosHpos, -1.0, 1.0 ) );
    // Limita os horizontes ao hemisferio da normal.
    h1 = gamma + max( h1 - gamma, -HALF_PI );
    h2 = gamma + min( h2 - gamma,  HALF_PI );

    float sinG = sin( gamma ), cosG = cos( gamma );
    visibility += projNlen * 0.25 * (
      ( h1 * 2.0 * sinG - cos( 2.0 * h1 - gamma ) + cosG ) +
      ( h2 * 2.0 * sinG - cos( 2.0 * h2 - gamma ) + cosG ) );
  }

  visibility /= float( SLICES );
  float ao = pow( clamp( visibility, 0.0, 1.0 ), uIntensity );
  gl_FragColor = vec4( ao, ao, ao, 1.0 );
}
`);

/* ========================================================================== */
/* 3. Blur bilateral separavel do AO                                           */
/* ========================================================================== */
export const AO_BLUR_FRAG = /* glsl */`
varying vec2 vUv;
uniform sampler2D tAO;
uniform sampler2D tND;
uniform vec2  uDir;         // (texel.x, 0) ou (0, texel.y)
uniform float uDepthSigma;

void main() {
  float z0 = texture2D( tND, vUv ).a;
  // Pesos gaussianos de 7 taps.
  float w[4];
  w[0] = 0.2865; w[1] = 0.2380; w[2] = 0.1362; w[3] = 0.0325;

  float sum = texture2D( tAO, vUv ).r * w[0];
  float wsum = w[0];

  for ( int i = 1; i < 4; i++ ) {
    vec2 o = uDir * float( i );
    for ( int s = 0; s < 2; s++ ) {
      vec2 uv = vUv + ( s == 0 ? o : -o );
      float z = texture2D( tND, uv ).a;
      // Corta o peso onde a profundidade salta: o AO nao vaza por cima de bordas.
      float wd = exp( -abs( z - z0 ) * uDepthSigma ) * w[ i ];
      sum += texture2D( tAO, uv ).r * wd;
      wsum += wd;
    }
  }
  float ao = sum / max( wsum, 1e-4 );
  gl_FragColor = vec4( ao, ao, ao, 1.0 );
}
`;

/* ========================================================================== */
/* 4. Composite do AO sobre a cena (upsample guiado por profundidade)          */
/* ========================================================================== */
export const AO_COMPOSITE_FRAG = glsl(GLSL_MATH, GLSL_DEPTH, /* glsl */`
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tAO;
uniform sampler2D tND;
uniform sampler2D tDepth;
uniform vec2  uHalfTexel;
uniform float uStrength;
uniform float uNear;
uniform float uFar;
uniform float uEnabled;

void main() {
  vec3 color = texture2D( tScene, vUv ).rgb;

  if ( uEnabled > 0.5 ) {
    float zFull = linearizeDepth( texture2D( tDepth, vUv ).x, uNear, uFar );

    // Upsample bilateral 4-tap: rejeita taps de meia-res que pertencem a outra
    // superficie, senao o AO "sangra" 2px alem das silhuetas.
    float sum = 0.0, wsum = 0.0;
    for ( int i = 0; i < 4; i++ ) {
      vec2 o = vec2( ( i == 1 || i == 3 ) ? 1.0 : -1.0,
                     ( i >= 2 ) ? 1.0 : -1.0 ) * uHalfTexel * 0.5;
      float zh = texture2D( tND, vUv + o ).a;
      float w = 1.0 / ( 1e-3 + abs( zh - zFull ) * 4.0 );
      sum += texture2D( tAO, vUv + o ).r * w;
      wsum += w;
    }
    float ao = sum / max( wsum, 1e-4 );

    float f = mix( 1.0, ao, uStrength );
    // Preserva realces: oclusao de ambiente nao deve apagar luz direta forte.
    f = mix( f, 1.0, clamp( luma( color ) * 0.10, 0.0, 0.5 ) );
    color *= f;
  }

  // alpha = 0 -> marca "pixel de mundo" (ver cabecalho do arquivo).
  gl_FragColor = vec4( color, 0.0 );
}
`);

/* ========================================================================== */
/* 5. Bloom — piramide dual-filter estilo Jimenez / Call of Duty               */
/* ========================================================================== */

const BLOOM_DOWN13 = /* glsl */`
// Downsample de 13 taps agrupados em 5 quadrados: mantem estabilidade temporal
// e evita o "quadrado" do box filter simples.
vec3 downsample13( sampler2D t, vec2 uv, vec2 tx, float karis ) {
  vec3 a = texture2D( t, uv + tx * vec2( -2.0,  2.0 ) ).rgb;
  vec3 b = texture2D( t, uv + tx * vec2(  0.0,  2.0 ) ).rgb;
  vec3 c = texture2D( t, uv + tx * vec2(  2.0,  2.0 ) ).rgb;
  vec3 d = texture2D( t, uv + tx * vec2( -1.0,  1.0 ) ).rgb;
  vec3 e = texture2D( t, uv + tx * vec2(  1.0,  1.0 ) ).rgb;
  vec3 f = texture2D( t, uv + tx * vec2( -2.0,  0.0 ) ).rgb;
  vec3 g = texture2D( t, uv ).rgb;
  vec3 h = texture2D( t, uv + tx * vec2(  2.0,  0.0 ) ).rgb;
  vec3 i = texture2D( t, uv + tx * vec2( -1.0, -1.0 ) ).rgb;
  vec3 j = texture2D( t, uv + tx * vec2(  1.0, -1.0 ) ).rgb;
  vec3 k = texture2D( t, uv + tx * vec2( -2.0, -2.0 ) ).rgb;
  vec3 l = texture2D( t, uv + tx * vec2(  0.0, -2.0 ) ).rgb;
  vec3 m = texture2D( t, uv + tx * vec2(  2.0, -2.0 ) ).rgb;

  vec3 g0 = ( d + e + i + j ) * 0.25;
  vec3 g1 = ( a + b + g + f ) * 0.25;
  vec3 g2 = ( b + c + h + g ) * 0.25;
  vec3 g3 = ( f + g + l + k ) * 0.25;
  vec3 g4 = ( g + h + m + l ) * 0.25;

  if ( karis > 0.5 ) {
    // Media de Karis: pesa por 1/(1+luma) e mata firefly de 1 pixel, que sem
    // isso vira um borrao piscante gigante no bloom.
    float w0 = 1.0 / ( 1.0 + luma( g0 ) );
    float w1 = 1.0 / ( 1.0 + luma( g1 ) );
    float w2 = 1.0 / ( 1.0 + luma( g2 ) );
    float w3 = 1.0 / ( 1.0 + luma( g3 ) );
    float w4 = 1.0 / ( 1.0 + luma( g4 ) );
    float sw = w0 * 0.5 + ( w1 + w2 + w3 + w4 ) * 0.125;
    return ( g0 * w0 * 0.5 + ( g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4 ) * 0.125 ) / max( sw, 1e-4 );
  }
  return g0 * 0.5 + ( g1 + g2 + g3 + g4 ) * 0.125;
}
`;

export const BLOOM_PREFILTER_FRAG = glsl(GLSL_MATH, BLOOM_DOWN13, /* glsl */`
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2  uTexel;
uniform float uThreshold;
uniform float uKnee;

void main() {
  vec3 c = downsample13( tSrc, vUv, uTexel, 1.0 );

  // Threshold com joelho suave: sem o joelho a transicao vira uma borda dura
  // visivel (halo quadrado) em superficies com gradiente.
  float br = maxc( c );
  float knee = max( uThreshold * uKnee, 1e-4 );
  float soft = clamp( br - uThreshold + knee, 0.0, 2.0 * knee );
  soft = soft * soft / ( 4.0 * knee );
  float contrib = max( soft, br - uThreshold ) / max( br, 1e-4 );

  gl_FragColor = vec4( c * contrib, 1.0 );
}
`);

export const BLOOM_DOWN_FRAG = glsl(GLSL_MATH, BLOOM_DOWN13, /* glsl */`
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
void main() { gl_FragColor = vec4( downsample13( tSrc, vUv, uTexel, 0.0 ), 1.0 ); }
`);

export const BLOOM_UP_FRAG = /* glsl */`
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2  uTexel;
uniform float uRadius;

void main() {
  // Tent 3x3 (1 2 1 / 2 4 2 / 1 2 1). Somado ao mip maior com AdditiveBlending.
  vec2 d = uTexel * uRadius;
  vec3 s = texture2D( tSrc, vUv + vec2( -d.x,  d.y ) ).rgb
         + texture2D( tSrc, vUv + vec2(  0.0,  d.y ) ).rgb * 2.0
         + texture2D( tSrc, vUv + vec2(  d.x,  d.y ) ).rgb
         + texture2D( tSrc, vUv + vec2( -d.x,  0.0 ) ).rgb * 2.0
         + texture2D( tSrc, vUv ).rgb * 4.0
         + texture2D( tSrc, vUv + vec2(  d.x,  0.0 ) ).rgb * 2.0
         + texture2D( tSrc, vUv + vec2( -d.x, -d.y ) ).rgb
         + texture2D( tSrc, vUv + vec2(  0.0, -d.y ) ).rgb * 2.0
         + texture2D( tSrc, vUv + vec2(  d.x, -d.y ) ).rgb;
  gl_FragColor = vec4( s * 0.0625, 1.0 );
}
`;

/* ========================================================================== */
/* 6. Motion blur por reprojecao de camera                                     */
/* ========================================================================== */
export const MOTION_BLUR_FRAG = glsl(GLSL_MATH, GLSL_DEPTH, /* glsl */`
varying vec2 vUv;
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform mat4  uInvViewProj;
uniform mat4  uPrevViewProj;
uniform float uStrength;
uniform float uMaxVelocity;   // em UV

#ifndef MB_SAMPLES
#define MB_SAMPLES 9
#endif

void main() {
  vec4 c = texture2D( tColor, vUv );

  // Viewmodel nunca borra — a arma acompanha a camera, borra-la parece bug.
  if ( c.a > 0.5 ) { gl_FragColor = c; return; }

  float d = texture2D( tDepth, vUv ).x;
  vec3 wp = worldPosFromDepth( vUv, d, uInvViewProj );
  vec4 pc = uPrevViewProj * vec4( wp, 1.0 );
  if ( pc.w <= 0.0 ) { gl_FragColor = c; return; }
  vec2 prevUv = ( pc.xy / pc.w ) * 0.5 + 0.5;

  vec2 vel = ( vUv - prevUv ) * uStrength;
  float len = length( vel );
  if ( len < 0.0009 ) { gl_FragColor = c; return; }
  vel *= min( 1.0, uMaxVelocity / len );

  float ign = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );

  vec3 sum = c.rgb;
  float wsum = 1.0;
  for ( int i = 1; i <= MB_SAMPLES; i++ ) {
    float t = ( ( float( i ) + ign ) / float( MB_SAMPLES + 1 ) ) - 0.5;
    vec4 s = texture2D( tColor, vUv + vel * t );
    float w = ( s.a > 0.5 ) ? 0.0 : 1.0;   // nao arrasta pixel da arma
    sum += s.rgb * w;
    wsum += w;
  }
  gl_FragColor = vec4( sum / wsum, c.a );
}
`);

/* ========================================================================== */
/* 7. Foco automatico (RT 1x1, suavizado no tempo)                             */
/* ========================================================================== */
export const FOCUS_FRAG = glsl(GLSL_DEPTH, /* glsl */`
varying vec2 vUv;
uniform sampler2D tDepth;
uniform sampler2D tPrev;
uniform float uNear;
uniform float uFar;
uniform float uSpeed;
uniform float uMaxFocus;

void main() {
  // Media de 5 taps no centro: um unico pixel pega um fio de cabelo e o foco pula.
  float d = texture2D( tDepth, vec2( 0.5 ) ).x;
  d = min( d, texture2D( tDepth, vec2( 0.485, 0.5 ) ).x );
  d = min( d, texture2D( tDepth, vec2( 0.515, 0.5 ) ).x );
  d = min( d, texture2D( tDepth, vec2( 0.5, 0.485 ) ).x );
  d = min( d, texture2D( tDepth, vec2( 0.5, 0.515 ) ).x );

  float z = clamp( linearizeDepth( d, uNear, uFar ), 0.5, uMaxFocus );
  float prev = texture2D( tPrev, vec2( 0.5 ) ).r;
  if ( prev <= 0.001 ) prev = z;
  gl_FragColor = vec4( mix( prev, z, uSpeed ), 0.0, 0.0, 1.0 );
}
`);

/* ========================================================================== */
/* 8. Depth of field — bokeh em espiral de angulo aureo                        */
/* ========================================================================== */
export const DOF_FRAG = glsl(GLSL_MATH, GLSL_DEPTH, /* glsl */`
varying vec2 vUv;
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tFocus;
uniform vec2  uTexel;
uniform float uNear;
uniform float uFar;
uniform float uMaxCoC;       // raio maximo em pixels
uniform float uAmount;       // 0 = desligado, 1 = ADS
uniform float uNearScale;    // quanto do campo proximo desfoca (pequeno fora do ADS)
uniform float uAperture;

#ifndef DOF_SAMPLES
#define DOF_SAMPLES 22
#endif

float cocOf( float z, float focus ) {
  return clamp( ( ( z - focus ) / max( z, 1e-3 ) ) * uAperture, -1.0, 1.0 );
}

void main() {
  vec4 c = texture2D( tColor, vUv );
  if ( uAmount <= 0.002 || c.a > 0.5 ) { gl_FragColor = c; return; }

  float focus = texture2D( tFocus, vec2( 0.5 ) ).r;
  float z = linearizeDepth( texture2D( tDepth, vUv ).x, uNear, uFar );

  float coc = cocOf( z, focus );
  if ( coc < 0.0 ) coc *= uNearScale;
  float r = abs( coc ) * uMaxCoC * uAmount;
  if ( r < 0.75 ) { gl_FragColor = c; return; }

  vec3 sum = c.rgb;
  float wsum = 1.0;
  float ign = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );

  for ( int i = 0; i < DOF_SAMPLES; i++ ) {
    float fi = float( i ) + 0.5 + ign;
    float ang = fi * 2.39996323;                       // angulo aureo
    float rad = sqrt( fi / float( DOF_SAMPLES ) ) * r; // area uniforme no disco
    vec2 uv = vUv + vec2( cos( ang ), sin( ang ) ) * rad * uTexel;

    vec4 s = texture2D( tColor, uv );
    float sz = linearizeDepth( texture2D( tDepth, uv ).x, uNear, uFar );
    float sc = cocOf( sz, focus );
    if ( sc < 0.0 ) sc *= uNearScale;
    float sr = abs( sc ) * uMaxCoC * uAmount;

    // O tap so contribui se o proprio circulo de confusao dele alcanca o centro.
    // Sem isso o fundo desfocado "vaza" por cima de um primeiro plano nitido.
    float w = ( s.a > 0.5 ) ? 0.0 : smoothstep( rad - 1.5, rad + 1.5, sr );
    // Contraste de bokeh: realces HDR viram discos brilhantes.
    w *= 1.0 + clamp( luma( s.rgb ) - 1.0, 0.0, 6.0 ) * 0.25;

    sum += s.rgb * w;
    wsum += w;
  }
  gl_FragColor = vec4( sum / wsum, c.a );
}
`);

/* ========================================================================== */
/* 9. Tonemap + color grade                                                    */
/* ========================================================================== */
export const TONEMAP_FRAG = glsl(GLSL_MATH, GLSL_HASH, GLSL_TONEMAP, /* glsl */`
varying vec2 vUv;
uniform vec2 uResolution;
uniform sampler2D tColor;
uniform sampler2D tBloom;
uniform float uExposure;
uniform float uBloomIntensity;

uniform vec3  uShadowTint;
uniform vec3  uHighlightTint;
uniform float uSplitBalance;
uniform float uContrast;
uniform float uSaturation;
uniform vec3  uLift;
uniform vec3  uGamma;
uniform vec3  uGain;
uniform float uBlackPoint;

void main() {
  vec3 c = texture2D( tColor, vUv ).rgb;

#ifdef USE_BLOOM
  c += texture2D( tBloom, vUv ).rgb * uBloomIntensity;
#endif

  c = max( c * uExposure, vec3( 0.0 ) );

  // --- Split toning em linear ------------------------------------------------
  // Sombras puxadas para o teal, realces para o laranja. Sutil de proposito:
  // teal-orange caricato e a marca de amador.
  float l = luma( c );
  float t = smoothstep( 0.0, 1.0, ( l / ( 1.0 + l ) - uSplitBalance ) * 2.2 + 0.5 );
  c *= mix( uShadowTint, uHighlightTint, t );

  // --- Curva filmica ---------------------------------------------------------
  c = acesFitted( c );
  c = linearToSRGB( c );

  // --- Grade em espaco de display -------------------------------------------
  c = ( c - 0.5 ) * uContrast + 0.5;
  c = clamp( c, 0.0, 1.0 );
  c = uGain * ( c + uLift * ( 1.0 - c ) );      // lift/gain
  c = pow( max( c, vec3( 0.0 ) ), 1.0 / uGamma );

  float lum = luma( c );
  c = clamp( mix( vec3( lum ), c, uSaturation ), 0.0, 1.0 );

  // Pretos densos: reancora o preto acima de zero e reescala.
  c = clamp( ( c - uBlackPoint ) / ( 1.0 - uBlackPoint ), 0.0, 1.0 );

  // Dither TPDF AQUI, e nao so no passe final: o alvo LDR e RGBA8 e a
  // quantizacao acontece nesta escrita. Ditherizar depois nao desfaz banda.
  float n1 = hash12( vUv * uResolution + 3.7 );
  float n2 = hash12( vUv * uResolution + 71.3 );
  c += ( n1 - n2 ) / 255.0;

  gl_FragColor = vec4( c, 1.0 );
}
`);

/* ========================================================================== */
/* 10. TAA — jitter Halton + reprojecao com clamp de vizinhanca                */
/* ========================================================================== */
export const TAA_FRAG = glsl(GLSL_MATH, GLSL_DEPTH, /* glsl */`
varying vec2 vUv;
uniform sampler2D tCurrent;
uniform sampler2D tHistory;
uniform sampler2D tDepth;
uniform mat4  uInvViewProj;
uniform mat4  uPrevViewProj;
uniform vec2  uTexel;
uniform float uFeedback;
uniform float uHistoryValid;

void main() {
  vec3 cur = texture2D( tCurrent, vUv ).rgb;

  if ( uHistoryValid < 0.5 ) { gl_FragColor = vec4( cur, 1.0 ); return; }

  float d = texture2D( tDepth, vUv ).x;
  vec3 wp = worldPosFromDepth( vUv, d, uInvViewProj );
  vec4 pc = uPrevViewProj * vec4( wp, 1.0 );
  vec2 prevUv = ( pc.xy / pc.w ) * 0.5 + 0.5;

  if ( pc.w <= 0.0 || prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0 ) {
    gl_FragColor = vec4( cur, 1.0 );
    return;
  }

  // Momentos da vizinhanca 3x3 em YCoCg -> caixa AABB por variancia.
  // Clamp por min/max puro engorda demais a caixa e deixa ghosting passar;
  // variancia (Salvi/Karis) aperta a caixa sem criar flicker.
  vec3 m1 = vec3( 0.0 ), m2 = vec3( 0.0 );
  for ( int y = -1; y <= 1; y++ ) {
    for ( int x = -1; x <= 1; x++ ) {
      vec3 s = rgb2ycocg( texture2D( tCurrent, vUv + vec2( float( x ), float( y ) ) * uTexel ).rgb );
      m1 += s;
      m2 += s * s;
    }
  }
  vec3 mu = m1 / 9.0;
  vec3 sigma = sqrt( max( m2 / 9.0 - mu * mu, vec3( 0.0 ) ) );
  vec3 lo = mu - 1.30 * sigma;
  vec3 hi = mu + 1.30 * sigma;

  vec3 hist = ycocg2rgb( clamp( rgb2ycocg( texture2D( tHistory, prevUv ).rgb ), lo, hi ) );

  // Movimento rapido -> confia menos no historico (menos ghosting em rotacao).
  float velPx = length( ( vUv - prevUv ) / uTexel );
  float fb = mix( uFeedback, 0.70, clamp( velPx / 26.0, 0.0, 1.0 ) );

  gl_FragColor = vec4( max( mix( cur, hist, fb ), vec3( 0.0 ) ), 1.0 );
}
`);

/* ========================================================================== */
/* 11. Finish — FXAA opcional + aberracao cromatica + vinheta + grain + dither */
/* ========================================================================== */
export const FINISH_FRAG = glsl(GLSL_MATH, GLSL_HASH, /* glsl */`
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2  uTexel;
uniform vec2  uResolution;
uniform float uTime;
uniform float uGrain;
uniform float uVignette;
uniform float uChromatic;
uniform float uAspect;

#ifdef USE_FXAA
// FXAA (variante NVIDIA classica). Barato e bom o bastante em silhueta;
// o TAA cobre o resto quando ativo.
vec3 fxaa( sampler2D tex, vec2 uv, vec2 tx ) {
  const float SPAN_MAX = 8.0;
  const float REDUCE_MUL = 0.125;
  const float REDUCE_MIN = 0.0078125;
  const vec3 L = vec3( 0.299, 0.587, 0.114 );

  vec3 rgbNW = texture2D( tex, uv + vec2( -1.0, -1.0 ) * tx ).rgb;
  vec3 rgbNE = texture2D( tex, uv + vec2(  1.0, -1.0 ) * tx ).rgb;
  vec3 rgbSW = texture2D( tex, uv + vec2( -1.0,  1.0 ) * tx ).rgb;
  vec3 rgbSE = texture2D( tex, uv + vec2(  1.0,  1.0 ) * tx ).rgb;
  vec3 rgbM  = texture2D( tex, uv ).rgb;

  float lNW = dot( rgbNW, L ), lNE = dot( rgbNE, L );
  float lSW = dot( rgbSW, L ), lSE = dot( rgbSE, L ), lM = dot( rgbM, L );
  float lMin = min( lM, min( min( lNW, lNE ), min( lSW, lSE ) ) );
  float lMax = max( lM, max( max( lNW, lNE ), max( lSW, lSE ) ) );

  vec2 dir = vec2( -( ( lNW + lNE ) - ( lSW + lSE ) ), ( ( lNW + lSW ) - ( lNE + lSE ) ) );
  float dirReduce = max( ( lNW + lNE + lSW + lSE ) * 0.25 * REDUCE_MUL, REDUCE_MIN );
  float rcpMin = 1.0 / ( min( abs( dir.x ), abs( dir.y ) ) + dirReduce );
  dir = clamp( dir * rcpMin, vec2( -SPAN_MAX ), vec2( SPAN_MAX ) ) * tx;

  vec3 rgbA = 0.5 * ( texture2D( tex, uv + dir * ( 1.0 / 3.0 - 0.5 ) ).rgb
                    + texture2D( tex, uv + dir * ( 2.0 / 3.0 - 0.5 ) ).rgb );
  vec3 rgbB = rgbA * 0.5 + 0.25 * ( texture2D( tex, uv + dir * -0.5 ).rgb
                                  + texture2D( tex, uv + dir *  0.5 ).rgb );
  float lB = dot( rgbB, L );
  return ( lB < lMin || lB > lMax ) ? rgbA : rgbB;
}
#endif

void main() {
  vec2 centered = vUv - 0.5;
  float r2 = dot( centered, centered );

#ifdef USE_FXAA
  vec3 col = fxaa( tSrc, vUv, uTexel );
#else
  vec3 col = texture2D( tSrc, vUv ).rgb;
#endif

  // --- Aberracao cromatica radial (cresce com r^2, como lente real) ---------
  if ( uChromatic > 0.001 ) {
    float amt = uChromatic * r2 * 0.006;
    col.r = texture2D( tSrc, vUv - centered * amt ).r;
    col.b = texture2D( tSrc, vUv + centered * amt ).b;
  }

  // --- Vinheta --------------------------------------------------------------
  // Curva larga e suave: vinheta curta e forte parece filtro de celular.
  float d = length( centered * vec2( uAspect, 1.0 ) );
  float vig = smoothstep( 0.50, 1.22, d );
  col *= 1.0 - vig * uVignette * 0.62;

  // --- Grain animado --------------------------------------------------------
  if ( uGrain > 0.001 ) {
    float g = hash12( vUv * uResolution + vec2( uTime * 91.37, uTime * 47.13 ) ) - 0.5;
    // Mais grao na sombra/meio-tom, quase nenhum no realce estourado.
    float weight = 1.0 - smoothstep( 0.35, 1.0, luma( col ) );
    col += g * uGrain * 0.09 * ( 0.35 + 0.65 * weight );
  }

  // --- Dither TPDF ----------------------------------------------------------
  // Obrigatorio: sem isso o ceu em gradiente mostra faixas de 1/255 no monitor.
  float n1 = hash12( vUv * uResolution + 17.0 );
  float n2 = hash12( vUv * uResolution + 89.0 );
  col += ( n1 - n2 ) / 255.0;

  gl_FragColor = vec4( clamp( col, 0.0, 1.0 ), 1.0 );
}
`);
