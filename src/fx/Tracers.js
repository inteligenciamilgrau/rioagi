/**
 * Tracers — tracantes. Dono: FX.
 *
 * Municao tracante real vem intercalada no pente (tipicamente 1 em 4/5). Aqui
 * usamos ~1 em 3 porque o tiro do jogador precisa de leitura imediata; quem
 * decide e o FXManager, este modulo so desenha.
 *
 * Cada tracante e UMA instancia de quad esticado entre a cauda e a cabeca do
 * projetil, orientado em espaco de camera (billboard de eixo). Toda a
 * cinematica esta no vertex shader — a CPU escreve origem/direcao/velocidade
 * uma unica vez. Aditivo, com nucleo branco e halo quente.
 *
 * Passagem rasante: quando o segmento passa perto da camera o quad e alargado e
 * recebe um deslocamento lateral dependente da distancia, o que produz aquele
 * borrao de "quase me pegou" em vez de um risco fino e limpo.
 */
import * as THREE from 'three';

const VERT = /* glsl */`
precision highp float;

attribute vec3 iOrigem;
attribute vec3 iDir;
attribute vec4 iP;     // nascimento, vida, velocidade, comprimento
attribute vec4 iCol;   // rgb, intensidade

uniform float uTime;
uniform float uLargura;

varying vec2 vUv;
varying vec3 vCor;
varying float vAlpha;
varying float vProx;

void main() {
  float t = uTime - iP.x;
  if (t < 0.0 || t >= iP.y || iP.y <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vUv = vec2(0.0); vCor = vec3(0.0); vAlpha = 0.0; vProx = 0.0;
    return;
  }
  float u = t / iP.y;

  float d = iP.z * t;
  vec3 cabeca = iOrigem + iDir * d;
  // a cauda nunca sai atras da boca do cano
  float comp = min(iP.w, d);
  vec3 cauda = cabeca - iDir * comp;

  vec4 mvC = modelViewMatrix * vec4(cabeca, 1.0);
  vec4 mvT = modelViewMatrix * vec4(cauda, 1.0);

  // distancia da camera (origem do espaco de visao) ao segmento
  vec3 ab = mvC.xyz - mvT.xyz;
  float ll = max(dot(ab, ab), 1e-6);
  float h = clamp(dot(-mvT.xyz, ab) / ll, 0.0, 1.0);
  float dist = length(mvT.xyz + ab * h);
  // 0 = longe, 1 = colado no ouvido
  vProx = clamp(1.0 - dist / 3.0, 0.0, 1.0);

  vec3 p = mix(mvT.xyz, mvC.xyz, uv.y);
  vec2 eixo = mvC.xy - mvT.xy;
  float le = length(eixo);
  eixo = le > 1e-5 ? eixo / le : vec2(0.0, 1.0);
  vec2 perp = vec2(-eixo.y, eixo.x);

  // largura constante em metros + alargamento na passagem rasante
  float larg = uLargura * (1.0 + vProx * 5.0);
  p.xy += perp * (position.x * larg);
  // leve deslocamento/ondulacao so no rasante (distorcao de ar quente)
  p.xy += perp * (vProx * vProx * 0.06 * sin(uv.y * 9.0 + iP.x * 31.0));

  gl_Position = projectionMatrix * vec4(p, 1.0);

  vUv = uv;
  vCor = iCol.rgb * iCol.a;
  // acende rapido, apaga no fim; a cabeca e mais quente que a cauda
  vAlpha = smoothstep(0.0, 0.06, u) * (1.0 - u * u);
}
`;

const FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
varying vec3 vCor;
varying float vAlpha;
varying float vProx;

void main() {
  float x = vUv.x * 2.0 - 1.0;
  float secao = pow(max(0.0, 1.0 - abs(x)), 2.2);   // secao redonda
  float nucleo = pow(max(0.0, 1.0 - abs(x)), 12.0);
  float longo = mix(0.25, 1.0, pow(vUv.y, 1.6));    // cauda mais fraca
  float a = secao * longo * vAlpha;
  vec3 cor = vCor * (0.65 + nucleo * 1.9) + vec3(1.0, 0.85, 0.6) * nucleo * 0.8;
  cor *= 1.0 + vProx * 1.6;
  gl_FragColor = vec4(cor * a, 0.0);   // aditivo puro, alpha do alvo intacto
}
`;

export class Tracers {
  /** @param {number} capacidade numero maximo de tracantes simultaneos */
  constructor(capacidade = 96) {
    this.capacidade = Math.max(8, capacidade | 0);
    this.limiteUso = this.capacidade;
    this.cursor = 0;
    this.tempo = 0;
    this._loSujo = Infinity;
    this._hiSujo = -Infinity;
    this._fim = new Float32Array(this.capacidade);
    this.vivos = 0;

    // quad com y em 0..1 (0 = cauda, 1 = cabeca)
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0,
    ]), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
      0, 0, 1, 0, 1, 1, 0, 1,
    ]), 2));
    g.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
    g.instanceCount = this.capacidade;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    const N = this.capacidade;
    this.aOrigem = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
    this.aDir = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
    this.aP = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
    this._attrs = [this.aOrigem, this.aDir, this.aP, this.aCol];
    for (const a of this._attrs) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iOrigem', this.aOrigem);
    g.setAttribute('iDir', this.aDir);
    g.setAttribute('iP', this.aP);
    g.setAttribute('iCol', this.aCol);

    this.uniforms = {
      uTime: { value: 0 },
      uLargura: { value: 0.035 },
    };

    const mat = new THREE.ShaderMaterial({
      name: 'fx.tracers',
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
      fog: false,
      lights: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });

    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.name = 'fx.tracers';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 13;
    this.mesh.matrixAutoUpdate = false;
    this.geometry = g;
    this.material = mat;
  }

  /**
   * @param {THREE.Vector3} origem boca do cano
   * @param {THREE.Vector3} dir normalizada
   * @param {number} distancia distancia ate o alvo (m); a vida e cortada nela
   * @param {object} [o] { velocidade, comprimento, cor, intensidade }
   */
  dispara(origem, dir, distancia, o = {}) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.limiteUso;

    const vel = o.velocidade ?? 340;          // nao e a velocidade real da bala:
    // a real (900 m/s) some antes do olho registrar. 340 le como "risco veloz".
    const comp = o.comprimento ?? 7.0;
    const alcance = Math.min(distancia > 0 ? distancia : 120, 160);
    const vida = Math.min(0.55, alcance / vel + comp / vel * 0.8);

    let p = i * 3;
    this.aOrigem.array[p] = origem.x; this.aOrigem.array[p + 1] = origem.y; this.aOrigem.array[p + 2] = origem.z;
    this.aDir.array[p] = dir.x; this.aDir.array[p + 1] = dir.y; this.aDir.array[p + 2] = dir.z;
    p = i * 4;
    const P = this.aP.array;
    P[p] = this.tempo; P[p + 1] = vida; P[p + 2] = vel; P[p + 3] = comp;
    const C = this.aCol.array;
    const c = o.cor ?? [1.0, 0.72, 0.34];
    const g = o.intensidade ?? 2.4;
    C[p] = c[0]; C[p + 1] = c[1]; C[p + 2] = c[2]; C[p + 3] = g;

    this._fim[i] = this.tempo + vida;
    if (i < this._loSujo) this._loSujo = i;
    if (i > this._hiSujo) this._hiSujo = i;
  }

  update(dt) {
    this.tempo += dt;
    this.uniforms.uTime.value = this.tempo;
    let n = 0;
    for (let i = 0; i < this._fim.length; i++) if (this._fim[i] > this.tempo) n++;
    this.vivos = n;
    if (this._loSujo > this._hiSujo) return;
    const lo = this._loSujo, hi = this._hiSujo;
    for (const a of this._attrs) {
      a.clearUpdateRanges();
      a.addUpdateRange(lo * a.itemSize, (hi - lo + 1) * a.itemSize);
      a.needsUpdate = true;
    }
    this._loSujo = Infinity; this._hiSujo = -Infinity;
  }

  setQuality(preset) {
    this.limiteUso = Math.max(8, Math.min(this.capacidade, preset?.maxTracers ?? this.capacidade));
    if (this.cursor >= this.limiteUso) this.cursor = 0;
  }

  limpa() {
    this.aP.array.fill(0);
    this._fim.fill(0);
    this.aP.clearUpdateRanges();
    this.aP.needsUpdate = true;
    this.cursor = 0;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
