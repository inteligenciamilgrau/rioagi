/**
 * Shaders do ceu — espalhamento atmosferico de Preetham + nuvens procedurais.
 * Dono: CORE.
 *
 * Duas variantes do MESMO fragment shader:
 *   - padrao  : triangulo de tela cheia dentro da cena; a direcao do raio vem
 *               da inversa da view-projection (funciona com jitter de TAA).
 *   - EQUIRECT: gera um mapa equiretangular para alimentar o PMREM (IBL).
 *               Nesse modo o disco solar e omitido (senao a luz do sol seria
 *               contada duas vezes: uma no IBL e outra na direcional).
 */
import { GLSL_MATH, GLSL_HASH, glsl } from './common.glsl.js';

/** Constantes do modelo de Preetham, compartilhadas pelos shaders. */
export const GLSL_ATMOSPHERE = /* glsl */`
#ifndef OCA_ATMOSPHERE
#define OCA_ATMOSPHERE
// Espessura optica no zenite (metros de "atmosfera equivalente").
const float RAYLEIGH_ZENITH = 8.4e3;
const float MIE_ZENITH      = 1.25e3;
const float THREE_OVER_16PI = 0.05968310365946075;
const float ONE_OVER_4PI    = 0.07957747154594767;
// cos do raio angular aparente do sol (~0.53 grau)
const float SUN_ANGULAR_COS = 0.9999566769464485;

float rayleighPhase( float cosTheta ) {
  return THREE_OVER_16PI * ( 1.0 + cosTheta * cosTheta );
}
float hgPhase( float cosTheta, float g ) {
  float g2 = g * g;
  float denom = pow( max( 1.0 - 2.0 * g * cosTheta + g2, 1e-4 ), 1.5 );
  return ONE_OVER_4PI * ( ( 1.0 - g2 ) / denom );
}

/** Massa de ar relativa (Kasten-Young) para um angulo zenital em radianos. */
float airMass( float zenithAngle ) {
  float degrees = zenithAngle * 180.0 / PI;
  return 1.0 / ( cos( zenithAngle ) + 0.15 * pow( max( 93.885 - degrees, 1e-3 ), -1.253 ) );
}

/** UV equiretangular na convencao do three (EquirectangularReflectionMapping). */
vec2 equirectUv( vec3 dir ) {
  float u = atan( dir.z, -dir.x ) / TWO_PI + 0.5;
  float v = asin( clamp( dir.y, -1.0, 1.0 ) ) / PI + 0.5;
  return vec2( u, v );
}
/** Inversa: uv equiretangular -> direcao unitaria. */
vec3 equirectDir( vec2 uv ) {
  float phi = ( uv.x - 0.5 ) * TWO_PI;
  float theta = ( uv.y - 0.5 ) * PI;
  float ct = cos( theta );
  return vec3( -cos( phi ) * ct, sin( theta ), sin( phi ) * ct );
}
#endif
`;

export const SKY_FRAG = glsl(GLSL_MATH, GLSL_ATMOSPHERE, /* glsl */`
varying vec2 vUv;

uniform vec3  uBetaR;          // coeficiente de Rayleigh (ja com o fator rayleigh)
uniform vec3  uBetaM;          // coeficiente de Mie (ja com mieCoefficient/turbidez)
uniform float uSunE;           // intensidade solar do modelo (com "earth shadow")
uniform vec3  uSunDir;         // direcao PARA o sol, normalizada
uniform float uMieG;
uniform float uSkyGamma;       // compressao de range: Preetham exagera o contraste
uniform float uSkyIntensity;
uniform float uSunDiskIntensity;
uniform vec3  uGroundColor;    // cor abaixo da linha do horizonte (bate com o fog)
uniform float uHorizonTint;    // quanto da extincao tinge o ceu rasante
uniform sampler2D uClouds;     // equiretangular RGBA16F: rgb = radiancia, a = cobertura
uniform float uCloudAmount;

// --- Radiancia do ENTORNO (so no mapa de ambiente, nunca no ceu visivel) ----
// O ceu nao e a unica coisa que uma superficie enxerga. Num beco de morro, boa
// parte do hemisferio de cima e parede de tijolo e reboco batida pelo sol raso.
// Essa radiancia e quente e nao esta em modelo nenhum de espalhamento — sem
// ela, tudo que aponta para cima recebe SO ceu, e ceu puro e azul por fisica.
uniform vec3  uBounceColor;    // radiancia media do casario iluminado
uniform float uBounceStrength; // 0 = so ceu (o ceu visivel usa 0)
uniform float uBounceReach;    // ate que seno de elevacao o casario ainda tapa
uniform float uChroma;         // 1 = croma do ceu intacto (o ceu visivel usa 1)

#ifndef EQUIRECT
uniform mat4 uInvProj;
uniform mat4 uInvView;
#endif

void main() {

  #ifdef EQUIRECT
    vec3 dir = equirectDir( vUv );
  #else
    // Reconstroi a direcao do raio de camera a partir do NDC.
    vec4 clip = vec4( vUv * 2.0 - 1.0, 1.0, 1.0 );
    vec4 vpos = uInvProj * clip;
    vec3 dir = normalize( ( uInvView * vec4( vpos.xyz / vpos.w, 0.0 ) ).xyz );
  #endif

  // --- Espalhamento ---------------------------------------------------------
  float zenithAngle = acos( max( 0.0, dir.y ) );
  float am = airMass( zenithAngle );
  float sR = RAYLEIGH_ZENITH * am;
  float sM = MIE_ZENITH * am;

  // Extincao (absorcao + out-scattering) ao longo do caminho.
  vec3 Fex = exp( -( uBetaR * sR + uBetaM * sM ) );

  float cosTheta = dot( dir, uSunDir );
  vec3 betaRTheta = uBetaR * rayleighPhase( cosTheta * 0.5 + 0.5 );
  vec3 betaMTheta = uBetaM * hgPhase( cosTheta, uMieG );
  vec3 ratio = ( betaRTheta + betaMTheta ) / ( uBetaR + uBetaM );

  vec3 Lin = pow( uSunE * ratio * ( 1.0 - Fex ), vec3( 1.5 ) );
  // Correcao de Preetham para sol raso: sem isso o horizonte fica cinza-chumbo.
  // Expoente 3.0 (e nao 5.0 do addon) porque queremos o entardecer bem marcado.
  float horizonMix = clamp( pow( 1.0 - max( uSunDir.y, 0.0 ), 3.0 ), 0.0, 1.0 );
  Lin *= mix( vec3( 1.0 ), pow( max( uSunE * ratio * Fex, vec3( 0.0 ) ), vec3( 0.5 ) ), horizonMix );

  vec3 sky = ( Lin + vec3( 0.0015, 0.0018, 0.0030 ) ) * 0.04;

  // Tinta de extincao rasante: o Preetham puro entrega um horizonte quase
  // branco porque o termo (1-Fex) satura em todos os canais. A luz que vem de
  // la, porem, atravessou 40x mais ar — e o azul simplesmente nao chega.
  float lowMask = 1.0 - smoothstep( 0.0, 0.24, dir.y );
  vec3 fexN = Fex / max( maxc( Fex ), 1e-4 );
  sky *= mix( vec3( 1.0 ), pow( fexN, vec3( 0.30 ) ), uHorizonTint * lowMask );

  // Preetham entrega um range ~350:1 entre zenite e horizonte; o real fica em
  // torno de 20:1. Comprimimos com uma gamma parcial e MANTEMOS o resultado em
  // HDR linear (nada de clamp) para o bloom/tonemap trabalharem.
  sky = pow( max( sky, vec3( 0.0 ) ), vec3( 1.0 / uSkyGamma ) ) * uSkyIntensity;

  // --- Nuvens ---------------------------------------------------------------
  if ( uCloudAmount > 0.001 && dir.y > -0.02 ) {
    vec4 cl = texture2D( uClouds, equirectUv( dir ) );
    float a = clamp( cl.a * uCloudAmount, 0.0, 1.0 );
    sky = mix( sky, cl.rgb, a );
  }

  // --- Disco solar (fora do IBL) -------------------------------------------
  #ifndef EQUIRECT
    // Escurecimento de limbo: a borda do disco e ~40% mais fraca que o centro.
    float d = smoothstep( SUN_ANGULAR_COS, SUN_ANGULAR_COS + 0.000015, cosTheta );
    float limb = mix( 0.62, 1.0, sqrt( max( 0.0, 1.0 - ( 1.0 - cosTheta ) / 0.0000433 ) ) );
    sky += Fex * ( uSunE * uSunDiskIntensity ) * d * limb;
    // Halo/glow atmosferico ao redor do sol (Mie forward scattering exagerado).
    float glow = pow( max( cosTheta, 0.0 ), 900.0 ) * 0.55 + pow( max( cosTheta, 0.0 ), 48.0 ) * 0.08
               + pow( max( cosTheta, 0.0 ), 6.0 ) * 0.012;
    sky += Fex * uSunE * uSunDiskIntensity * glow * 0.16;
  #endif

  // --- Abaixo do horizonte --------------------------------------------------
  // Nao existe "chao" no ceu: fundimos para a cor da neblina do vale para que a
  // geometria distante e o ceu se encontrem sem uma linha dura.
  float belowMask = smoothstep( 0.015, -0.055, dir.y );
  sky = mix( sky, uGroundColor, belowMask );

  // --- O entorno (so no mapa de ambiente) -----------------------------------
  // Primeiro o trim de croma, que age so no que ainda e ceu.
  sky = mix( vec3( luma( sky ) ), sky, uChroma );

  // Depois o casario TAPA o ceu. E oclusao, nao luz extra: o mix conserva
  // energia, enquanto somar inflaria a exposicao (que ja esta calibrada).
  // Perfil da mascara: PLATO ate a metade do alcance e so entao a queda. Uma
  // casa de 6 m do outro lado de uma viela de 4 m sobe a 56 graus, e num beco
  // de 1,5 m passa de 70 — o casario nao e uma tira rente ao horizonte, e a
  // maior parte do hemisferio de cima. (Com queda comecando em zero, a mascara
  // morria justamente na faixa de 20 a 60 graus, que carrega 61% da
  // irradiancia de uma normal para cima — medido em tools/iblirrad.mjs.)
  float r1 = max( uBounceReach, 1e-3 );
  float bm = 1.0 - smoothstep( r1 * 0.5, r1, max( dir.y, 0.0 ) );
  sky = mix( sky, uBounceColor, clamp( uBounceStrength * bm, 0.0, 1.0 ) );

  gl_FragColor = vec4( max( sky, vec3( 0.0 ) ), 1.0 );

  // No caminho com PostFX o renderer esta em NoToneMapping e estes includes
  // viram no-op (mantendo HDR linear). No caminho direto (sem PostFX) eles
  // aplicam ACES + sRGB, para o ceu nao estourar branco.
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`);

/**
 * Nuvens: raymarch de baixa amostragem escrito num equiretangular pequeno,
 * atualizado a cada N frames (nao por frame). O custo real fica em ~1/20 avo.
 */
export const CLOUDS_FRAG = glsl(GLSL_MATH, GLSL_HASH, GLSL_ATMOSPHERE, /* glsl */`
varying vec2 vUv;

uniform vec3  uSunDir;
uniform vec3  uSunColor;      // radiancia direta do sol (ja atenuada pela atmosfera)
uniform vec3  uSkyColor;      // ambiente do ceu para o lado sombreado
uniform float uTime;
uniform float uCoverage;      // 0 = ceu limpo, 1 = encoberto
uniform float uDensity;

const float CLOUD_BASE = 1100.0;   // metros
const float CLOUD_TOP  = 2300.0;
const int   MARCH_STEPS = 12;
const int   LIGHT_STEPS = 3;

/** Densidade de cumulus num ponto do slab. */
float cumulus( vec3 p ) {
  float h = clamp( ( p.y - CLOUD_BASE ) / ( CLOUD_TOP - CLOUD_BASE ), 0.0, 1.0 );
  // Base chapada, topo em couve-flor.
  float grad = smoothstep( 0.0, 0.18, h ) * ( 1.0 - smoothstep( 0.5, 1.0, h ) );

  vec3 wind = vec3( uTime * 0.9, 0.0, uTime * 0.32 );
  vec3 q = ( p + wind ) * 0.00042;
  float base = fbm3( q, 4 );

  float d = smoothstep( 1.0 - uCoverage, 1.0 - uCoverage + 0.26, base );
  // Erosao das bordas com detalhe de alta frequencia: sem isso a nuvem vira bolha.
  float erosion = fbm3( ( p + wind * 2.0 ) * 0.0031, 3 );
  d -= erosion * 0.45 * ( 1.0 - smoothstep( 0.0, 0.35, d ) );
  return max( d, 0.0 ) * grad;
}

/** Transmitancia aproximada na direcao do sol (3 passos longos). */
float lightMarch( vec3 p ) {
  float t = 0.0;
  float dens = 0.0;
  float stp = 90.0;   // nao usar o nome "step": colide com a builtin do GLSL
  for ( int i = 0; i < LIGHT_STEPS; i++ ) {
    t += stp;
    dens += cumulus( p + uSunDir * t ) * stp;
    stp *= 2.2;
  }
  return exp( -dens * uDensity * 1.35 );
}

/** Cirros: camada fina e estriada bem alta, otima para entardecer. */
float cirrus( vec3 dir ) {
  if ( dir.y < 0.03 ) return 0.0;
  vec3 p = dir * ( 7000.0 / dir.y );
  vec3 q = vec3( p.x * 0.00006, 0.0, p.z * 0.00022 ) + vec3( uTime * 0.02, 0.0, 0.0 );
  float n = fbm3( q * 6.0, 4 );
  float streak = fbm3( vec3( q.x * 1.2, 7.3, q.z * 9.0 ), 3 );
  float d = smoothstep( 0.52, 0.78, n * 0.65 + streak * 0.45 );
  return d * smoothstep( 0.03, 0.22, dir.y ) * 0.55;
}

void main() {
  vec3 dir = equirectDir( vUv );

  vec3 color = vec3( 0.0 );
  float alpha = 0.0;

  if ( dir.y > 0.028 ) {
    float t0 = CLOUD_BASE / dir.y;
    float t1 = CLOUD_TOP / dir.y;
    float span = min( t1 - t0, 9000.0 );
    float stepLen = span / float( MARCH_STEPS );

    float cosTheta = dot( dir, uSunDir );
    // Duas lobulos de HG: forward (silver lining) + retro (ambiente difuso).
    float phase = mix( hgPhase( cosTheta, 0.72 ), hgPhase( cosTheta, -0.18 ), 0.42 ) * 6.0;

    float T = 1.0;
    // Dither radial para quebrar o banding do numero baixo de passos.
    float jitter = hash12( vUv * 811.7 );
    float t = t0 + stepLen * jitter;

    for ( int i = 0; i < MARCH_STEPS; i++ ) {
      vec3 p = dir * t;
      float d = cumulus( p );
      if ( d > 0.002 ) {
        float ls = lightMarch( p );
        // Beer-Powder: escurece o interior sem apagar a borda iluminada.
        float powder = 1.0 - exp( -d * 6.0 );
        vec3 lum = uSunColor * ( ls * phase * powder + 0.045 ) + uSkyColor * 0.85;
        float a = 1.0 - exp( -d * stepLen * uDensity );
        color += T * lum * a;
        alpha += T * a;
        T *= 1.0 - a;
        if ( T < 0.02 ) break;
      }
      t += stepLen;
    }
    // Some perto do horizonte: a aproximacao plano-paralela explode ali.
    float horizonFade = smoothstep( 0.028, 0.13, dir.y );
    color *= horizonFade;
    alpha *= horizonFade;
  }

  // Cirros por cima, iluminados de raspao (o que da o rosa/laranja do fim de tarde).
  float ci = cirrus( dir );
  if ( ci > 0.001 ) {
    float cosTheta = dot( dir, uSunDir );
    vec3 cirrusCol = uSunColor * ( 0.55 + 0.9 * pow( max( cosTheta, 0.0 ), 3.0 ) ) + uSkyColor * 0.5;
    color = mix( color, cirrusCol, ci * ( 1.0 - alpha * 0.7 ) );
    alpha = alpha + ci * ( 1.0 - alpha );
  }

  gl_FragColor = vec4( color, clamp( alpha, 0.0, 1.0 ) );
}
`);
