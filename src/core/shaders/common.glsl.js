/**
 * Trechos de GLSL compartilhados pelos shaders do CORE.
 * Escrito em estilo GLSL1 (varying / texture2D / gl_FragColor): o three converte
 * automaticamente para GLSL3 em WebGL2 via os defines de compatibilidade.
 */

export const GLSL_MATH = /* glsl */`
#ifndef OCA_MATH
#define OCA_MATH
const float PI      = 3.14159265359;
const float TWO_PI  = 6.28318530718;
const float HALF_PI = 1.57079632679;
const float INV_PI  = 0.31830988618;

float luma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
float maxc( vec3 c ) { return max( c.r, max( c.g, c.b ) ); }
float sq( float x ) { return x * x; }

// Conversao para YCoCg — espaco usado no clamp de vizinhanca do TAA porque
// separa luminancia de crominancia e evita "manchas" coloridas no clip.
vec3 rgb2ycocg( vec3 c ) {
  return vec3(
    0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
    0.5  * c.r - 0.5 * c.b,
   -0.25 * c.r + 0.5 * c.g - 0.25 * c.b );
}
vec3 ycocg2rgb( vec3 c ) {
  float t = c.x - c.z;
  return vec3( t + c.y, c.x + c.z, t - c.y );
}
#endif
`;

export const GLSL_HASH = /* glsl */`
#ifndef OCA_HASH
#define OCA_HASH
// Hashes sem textura (Dave Hoskins). Baratos e sem banding perceptivel.
float hash11( float p ) {
  p = fract( p * 0.1031 );
  p *= p + 33.33;
  p *= p + p;
  return fract( p );
}
float hash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
vec2 hash22( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.xx + p3.yz ) * p3.zy );
}
float hash13( vec3 p3 ) {
  p3 = fract( p3 * 0.1031 );
  p3 += dot( p3, p3.zyx + 31.32 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

// Value noise 3D com interpolacao quintica (derivada continua -> sem facetas).
float vnoise3( vec3 x ) {
  vec3 i = floor( x );
  vec3 f = fract( x );
  f = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
  return mix(
    mix( mix( hash13( i + vec3( 0, 0, 0 ) ), hash13( i + vec3( 1, 0, 0 ) ), f.x ),
         mix( hash13( i + vec3( 0, 1, 0 ) ), hash13( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
    mix( mix( hash13( i + vec3( 0, 0, 1 ) ), hash13( i + vec3( 1, 0, 1 ) ), f.x ),
         mix( hash13( i + vec3( 0, 1, 1 ) ), hash13( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
}

// FBM com rotacao entre oitavas — a matriz quebra o alinhamento em grade
// que denuncia noise procedural barato.
const mat3 FBM_ROT = mat3( 0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64 );
float fbm3( vec3 p, int octaves ) {
  float a = 0.5, sum = 0.0, norm = 0.0;
  for ( int i = 0; i < 8; i++ ) {
    if ( i >= octaves ) break;
    sum += a * vnoise3( p );
    norm += a;
    p = FBM_ROT * p * 2.02;
    a *= 0.5;
  }
  return sum / max( norm, 1e-4 );
}
#endif
`;

export const GLSL_DEPTH = /* glsl */`
#ifndef OCA_DEPTH
#define OCA_DEPTH
/**
 * Depth do buffer padrao ([0,1], nao-linear) -> distancia de vista positiva.
 * near/far sao os da camera de mundo.
 */
float linearizeDepth( float d, float near, float far ) {
  float z = d * 2.0 - 1.0;
  return ( 2.0 * near * far ) / ( far + near - z * ( far - near ) );
}

/**
 * Posicao em espaco de vista a partir do depth linear.
 * invProjParams = vec2( 1/P[0][0], 1/P[1][1] ) = ( tan(fovX/2), tan(fovY/2) ).
 * Usa SEMPRE a projecao sem jitter de TAA — o erro de sub-pixel e irrelevante
 * aqui e evita que SSAO/DOF tremam junto com o jitter.
 */
vec3 viewPosFromLinear( vec2 uv, float linearZ, vec2 invProjParams ) {
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3( ndc * invProjParams, -1.0 ) * linearZ;
}

/** Posicao em espaco de mundo a partir do depth bruto. */
vec3 worldPosFromDepth( vec2 uv, float rawDepth, mat4 invViewProj ) {
  vec4 clip = vec4( uv * 2.0 - 1.0, rawDepth * 2.0 - 1.0, 1.0 );
  vec4 wp = invViewProj * clip;
  return wp.xyz / wp.w;
}
#endif
`;

export const GLSL_TONEMAP = /* glsl */`
#ifndef OCA_TONEMAP
#define OCA_TONEMAP
// ACES fitted (Stephen Hill). Matrizes ja transpostas para a convencao
// coluna-maior do GLSL.
const mat3 ACES_IN = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777 );
const mat3 ACES_OUT = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602 );

vec3 rrtOdtFit( vec3 v ) {
  vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
  vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
  return a / b;
}
vec3 acesFitted( vec3 color ) {
  color = ACES_IN * color;
  color = rrtOdtFit( color );
  color = ACES_OUT * color;
  return clamp( color, 0.0, 1.0 );
}

vec3 linearToSRGB( vec3 c ) {
  c = max( c, vec3( 0.0 ) );
  return mix( c * 12.92,
              1.055 * pow( max( c, vec3( 1e-5 ) ), vec3( 1.0 / 2.4 ) ) - 0.055,
              step( vec3( 0.0031308 ), c ) );
}
vec3 srgbToLinear( vec3 c ) {
  return mix( c / 12.92,
              pow( ( max( c, vec3( 0.0 ) ) + 0.055 ) / 1.055, vec3( 2.4 ) ),
              step( vec3( 0.04045 ), c ) );
}
#endif
`;

/** Concatena os blocos pedidos, na ordem. */
export function glsl(...blocks) { return blocks.join('\n'); }
