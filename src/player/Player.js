/**
 * Player — orquestra movimento, câmera, armas e viewmodel.
 * Dono: PLAYER. Ponto único de contato do módulo com o resto do jogo.
 *
 * Ciclo: lê o Input → Movement → CameraRig → WeaponSystem → ViewModel.
 * A câmera do mundo só é escrita aqui.
 */

import * as THREE from 'three';
import { Movement, DIM } from './Movement.js';
import { CameraRig } from './CameraRig.js';
import { WeaponSystem } from './WeaponSystem.js';
import { ViewModel } from './ViewModel.js';
import { WEAPONS, LOADOUT } from './Weapons.js';

const _move = { x: 0, y: 0 };
const _look = { x: 0, y: 0 };
const _cmd = {
  move: _move, yaw: 0, jump: false, jumpDown: false,
  crouchDown: false, crouchPressed: false, sprint: false, ads: false,
};
const _state = {};
const _dmgDir = new THREE.Vector3();
const _rumoOrigem = new THREE.Vector3();
const _rumoDir = new THREE.Vector3();
const _acaoOrigem = new THREE.Vector3();
const _acaoDir = new THREE.Vector3();
const _rumoAlturas = [-0.35, 0, 0.45];   // joelho, olho, telhado

const HEALTH_MAX = 100;
const REGEN_DELAY = 4.2;     // segundos sem tomar dano
const REGEN_RATE = 32;       // hp/s
/** Abaixo disso o jogador saiu do mundo (o ponto mais baixo do terreno e ~-3 m). */
const FUNDO_DO_MUNDO = -40;

/* ------------------------------------------------------------------ *
 * Rumo inicial — para onde o jogador olha ao nascer
 * ------------------------------------------------------------------ */

/**
 * CONVENCAO DE YAW (medida, nao suposta — ver tools/yaw.mjs).
 * O CameraRig compoe `_e.set(pitch, yaw, roll, 'YXZ')`, ou seja R = Ry·Rx·Rz,
 * e a camera olha para o -Z local. Logo, com pitch/roll zerados:
 *
 *     direcao_mundial(yaw) = (-sin(yaw), 0, -cos(yaw))
 *
 * Conferido no jogo rodando: yaw 0° -> (0,0,-1), 90° -> (-1,0,0), 180° -> (0,0,1).
 * Invertendo, para olhar de `p` PARA `t`:
 *
 *     yaw = atan2(-(t.x - p.x), -(t.z - p.z))
 *
 * ATENCAO: `atan2(-p.x, -p.z)` — que o codigo antigo usava para "olhar para a
 * origem" — e exatamente a formula com o sinal trocado, ou seja aponta 180° NO
 * SENTIDO CONTRARIO. Era essa a causa do jogador nascer de costas para o mapa
 * (o mesmo engano esta no yaw guardado em World.js, por isso ignoramos ele).
 */
function yawPara(px, pz, tx, tz) {
  return Math.atan2(-(tx - px), -(tz - pz));
}

const OLHO = 1.68;             // altura do olho, igual a do CameraRig
const N_SETORES = 72;          // leque de 5° em 5°
const ARCO = 6;                // +-6 setores = +-30°, o miolo do campo de visao
/** Abaixo disso e "parede na cara": enche a tela e nao se ve nada. */
const PERTO_DEMAIS = 3.0;
/** Distancia de fachada que rende a melhor foto de favela. */
const DIST_IDEAL = 22;
const DIST_LONGE = 70;

/**
 * Superficies de coisa CONSTRUIDA (as que o `Collision` sabe reportar).
 * Ganham peso maior porque sao literalmente o casario que queremos na tela.
 */
const SUP_URBANA = new Set(['concreto', 'tijolo', 'metal', 'madeira', 'vidro', 'asfalto']);
/**
 * `terra` = encosta pelada do morro. Evitar nao e capricho: o capim e desenhado
 * em cartoes grandes que a colisao NAO conhece, entao um spawn no meio do mato
 * aparece na tela como um paredao verde a um palmo do nariz enquanto o raycast
 * jura que o caminho esta livre por 20 m. Medido com `tools/semcapim.mjs`:
 * escondendo o material `grama` a mesma vista vira um beco de favela normal —
 * ver shots/spawn-diag-sem-capim.png.
 */
const SUP_MATO = new Set(['terra', 'folhagem', 'agua']);

/** Nota de um unico raio: quanto de "casario util" ele encontrou. */
function notaRaio(d, sup) {
  if (d < PERTO_DEMAIS) return -8;                       // parede colada
  if (d < 5.5) return -1;                                // fachada apertada demais
  if (d > DIST_LONGE) return 0.15;                       // ceu / vazio fora do morro
  const base = 1 + (1 - Math.abs(d - DIST_IDEAL) / 48);
  if (SUP_URBANA.has(sup)) return base * 1.35;
  if (SUP_MATO.has(sup)) return base * 0.3;
  return base;
}

export class Player {
  constructor(ctx) {
    this.ctx = ctx;
    this.pausable = true;

    this.movement = new Movement(ctx);
    this.rig = new CameraRig(ctx);
    this.weapons = new WeaponSystem(ctx, this.rig);
    this.viewModel = new ViewModel(ctx, this.weapons, this.rig);

    this.health = HEALTH_MAX;
    this.maxHealth = HEALTH_MAX;
    this.alive = true;
    this._sinceDamage = 99;
    this._emittingDamage = false;

    this.enabled = true;
    this._unbind = [];

    /* --- acao de uso (KeyF): porta na mira --- */
    this._acaoAlvo = null;
    this._acaoRotulo = null;    // null | 'abrir' | 'fechar'
  }

  /** Posição dos pés (contrato para IA e HUD). */
  get position() { return this.movement.position; }
  /** Posição do olho/câmera. */
  get eyePosition() { return this.rig.worldPosition; }
  get velocity() { return this.movement.velocity; }
  get state() { return this.movement.state; }
  get weapon() { return this.weapons.weapon; }
  get isADS() { return this.weapons.adsT > 0.5; }
  get spread() { return this.weapons.spread; }

  async init() {
    const ctx = this.ctx;

    /* --- spawn --- */
    let spawn = null;
    try { spawn = this._escolherSpawn(); } catch { spawn = null; }
    if (spawn?.p) {
      const p = spawn.p;
      this.movement.teleport(p.x, p.y + 0.1, p.z);
      // O yaw guardado no ponto de spawn está 180° errado (ver `yawPara`), e
      // "olhar para a origem" também não serve: (0,0) fica dentro do morro e
      // costuma cair de cara numa parede. Medimos a direção na hora.
      this.rig.reset(spawn.yaw, 0);
    } else {
      this.movement.teleport(0, 1.2, 0);
      this.rig.reset(0, 0);
    }

    await this.viewModel.init();

    /* --- eventos que o Player consome --- */
    const bus = ctx.bus;
    this._unbind.push(bus.on('weapon:fire', () => {
      this.viewModel.addRecoil(this.weapons.weapon);
    }));
    this._unbind.push(bus.on('player:land', ({ velocity }) => {
      this.rig.addLand(velocity);
    }));
    // Dano vindo da IA (contrato: AI emite player:damaged).
    this._unbind.push(bus.on('player:damaged', (p) => {
      if (this._emittingDamage) return;   // evita contar duas vezes o nosso próprio evento
      if (typeof p?.health === 'number') this.health = p.health;
      this._sinceDamage = 0;
      this.rig.addShake(THREE.MathUtils.clamp((p?.damage ?? 10) / 55, 0.12, 0.9), p?.fromDir ?? null);
      if (this.health <= 0 && this.alive) this._die();
    }));
    this._unbind.push(bus.on('fx:explosion', (p) => {
      if (!p?.position) return;
      const d = _dmgDir.copy(p.position).sub(this.eyePosition);
      const dist = d.length();
      if (dist > (p.radius ?? 8)) return;
      d.multiplyScalar(-1 / Math.max(0.01, dist));
      this.rig.addPunch(THREE.MathUtils.clamp(1 - dist / (p.radius ?? 8), 0, 1) * 0.9, d);
    }));

    this.weapons._emitState(true);
    ctx.player = this;
  }

  /**
   * Escolhe para onde o jogador olha ao nascer em `p`.
   *
   * PORQUE assim, e não "olhar para a origem":
   *  - a origem (0,0) não é o miolo do jogo, é só o zero do sistema de
   *    coordenadas — no nosso mapa ela cai DENTRO do morro. Mirar nela põe o
   *    jogador de cara numa parede quase sempre;
   *  - o que importa é o que está NA TELA. Então varremos o horizonte com um
   *    leque de raycasts e escolhemos o setor que mostra mais casario a média
   *    distância: nem parede colada (< 3 m, enche a tela), nem vazio (> 70 m,
   *    só céu). O pico da nota fica em ~22 m, que é onde a favela aparece em
   *    camadas de telhado.
   *  - empates vão para dentro do mapa: somamos um bônus pelo alinhamento com
   *    o centroide dos spawns (onde o mapa realmente está). É isso que impede
   *    um spawn de borda de nascer olhando para fora do morro, para o nada.
   *
   * @param {{x:number,y:number,z:number}} p posição dos pés no spawn
   * @returns {number} yaw em radianos, na convenção do CameraRig
   */
  _rumoInicial(p) { return this._avaliarRumo(p).yaw; }

  /**
   * Mesma varredura de `_rumoInicial`, mas devolve também a NOTA da melhor
   * vista — é o que permite comparar pontos de spawn entre si.
   * @returns {{yaw:number, nota:number}}
   */
  _avaliarRumo(p) {
    const world = this.ctx.world;

    /* --- alvo de referência: centroide dos spawns (onde há mapa jogável) --- */
    let alvoX = 0, alvoZ = 0;
    const pts = world?.getSpawnPoints?.() ?? [];
    if (pts.length) {
      for (const s of pts) {
        const q = s.position ?? s;
        alvoX += q.x; alvoZ += q.z;
      }
      alvoX /= pts.length; alvoZ /= pts.length;
    }
    const rumoCentro = yawPara(p.x, p.z, alvoX, alvoZ);

    const col = world?.collision;
    if (typeof col?.raycast !== 'function') return { yaw: rumoCentro, nota: 0 };

    /* --- leque: nota de cada direção --- */
    const origem = _rumoOrigem.set(p.x, p.y + 0.1 + OLHO, p.z);
    const notas = new Float64Array(N_SETORES);
    for (let i = 0; i < N_SETORES; i++) {
      const yaw = (i / N_SETORES) * Math.PI * 2;
      const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
      let soma = 0;
      // três alturas: joelho, olho e telhado — pega a fachada inteira, e não
      // só o pedaço de muro que por acaso está na linha do olho.
      for (const dy of _rumoAlturas) {
        _rumoDir.set(dx, dy, dz);
        const h = col.raycast(origem, _rumoDir, 150);
        // `raycast` devolve um objeto reaproveitado: lemos na hora.
        soma += notaRaio(h.hit ? h.distance : Infinity, h.hit ? h.surface : null);
      }
      notas[i] = soma / _rumoAlturas.length;
    }

    /* --- melhor setor: média do arco central + bônus de "para dentro" --- */
    let melhorYaw = rumoCentro, melhorNota = -Infinity;
    for (let i = 0; i < N_SETORES; i++) {
      let soma = 0, peso = 0;
      for (let k = -ARCO; k <= ARCO; k++) {
        // peso cosseno: o que está bem à frente conta mais que a periferia.
        const w = Math.cos((k / (ARCO + 1)) * (Math.PI / 2));
        soma += notas[((i + k) % N_SETORES + N_SETORES) % N_SETORES] * w;
        peso += w;
      }
      const yaw = (i / N_SETORES) * Math.PI * 2;
      const nota = soma / peso + 0.35 * Math.cos(yaw - rumoCentro);
      if (nota > melhorNota) { melhorNota = nota; melhorYaw = yaw; }
    }
    return { yaw: melhorYaw, nota: melhorNota };
  }

  /**
   * Escolhe ONDE nascer, além de para onde olhar.
   *
   * PORQUE: pegar `getSpawnPoints()[0]` era sorteio disfarçado — a lista sai
   * embaralhada do World e o ponto 0 deste mapa cai no meio do capim, onde o
   * jogador nasce encarando um paredão verde em 360°: não existe yaw que
   * resolva. Como os 80 pontos são todos válidos (a IA nasce neles), damos ao
   * jogador o que tiver a melhor vista, medida pelo mesmo leque de raycasts.
   * Determinístico: mesma seed, mesmo spawn.
   *
   * @returns {{p:object, yaw:number}|null}
   */
  _escolherSpawn() {
    const pts = this.ctx.world?.getSpawnPoints?.() ?? [];
    if (!pts.length) return null;

    let melhor = null, melhorNota = -Infinity;
    for (const s of pts) {
      const p = s.position ?? s;
      if (!p || typeof p.x !== 'number') continue;
      const { yaw, nota } = this._avaliarPonto(p);
      if (nota > melhorNota) { melhorNota = nota; melhor = { p, yaw }; }
    }
    if (melhor) return melhor;
    const p0 = pts[0].position ?? pts[0];
    return p0 ? { p: p0, yaw: this._rumoInicial(p0) } : null;
  }

  /**
   * Nota de um ponto de spawn como LUGAR (não só a direção): a nota da melhor
   * vista, menos o desconto de nascer no mato.
   * @returns {{yaw:number, nota:number}}
   */
  _avaliarPonto(p) {
    const r = this._avaliarRumo(p);
    const col = this.ctx.world?.collision;
    if (typeof col?.raycast !== 'function') return r;
    // Chão de terra = encosta de capim; o mato é desenhado em cartões que a
    // colisão não conhece, então ele tapa a tela sem o raycast ver nada.
    // Rua, laje e calçada é que rendem a foto de favela.
    _rumoOrigem.set(p.x, p.y + 2, p.z);
    _rumoDir.set(0, -1, 0);
    const chao = col.raycast(_rumoOrigem, _rumoDir, 6);
    // Desconto alto de propósito: um ponto no capim pode ter ótima nota de
    // leque (a colisão enxerga longe por cima do mato) e ainda assim mostrar
    // só verde na tela. Medido: com desconto 1.2 esse ponto ainda vencia o
    // sorteio de respawn — ver shots/spawn-renascer.png.
    if (chao.hit && SUP_MATO.has(chao.surface)) r.nota -= 2.5;
    return r;
  }

  /* ================================================================ *
   * Update
   * ================================================================ */
  update(dt) {
    const ctx = this.ctx;
    const input = ctx.input;
    const ws = this.weapons;

    this._checarQueda();

    /* ---------------- entrada ---------------- */
    let firing = false, adsWant = false;
    if (this.enabled && this.alive && input?.locked) {
      input.getMoveVector(_move);
      input.consumeLook(_look);
      const adsScale = THREE.MathUtils.lerp(1, ctx.settings?.adsSensitivityScale ?? 0.65, ws.adsT);
      const sens = (ctx.settings?.sensitivity ?? 0.0022) * adsScale;
      this.rig.look(_look.x, _look.y, sens, ctx.settings?.invertY);

      firing = input.fireDown || input.firePressed;
      adsWant = input.adsDown;

      if (input.wasPressed('reload')) ws.startReload();
      if (input.wasPressed('inspect')) ws.inspect();
      if (input.wasPressed('weapon1')) ws.switchTo(0);
      if (input.wasPressed('weapon2')) ws.switchTo(1);
      if (input.wasPressed('weapon3')) ws.switchTo(2);
      if (input.wasPressed('swap')) ws.swapPrevious();
      if (input.wheel) {
        const n = ws.slots.length;
        ws.switchTo(((ws.index + (input.wheel > 0 ? 1 : -1)) % n + n) % n);
      }

      _cmd.jump = input.wasPressed('jump');
      _cmd.jumpDown = input.isDown('jump');
      _cmd.crouchDown = input.isDown('crouch');
      _cmd.crouchPressed = input.wasPressed('crouch');
      _cmd.sprint = input.isDown('sprint');
    } else {
      _move.x = 0; _move.y = 0;
      _cmd.jump = false; _cmd.jumpDown = false;
      _cmd.crouchDown = false; _cmd.crouchPressed = false; _cmd.sprint = false;
    }

    _cmd.yaw = this.rig.yaw;
    _cmd.ads = ws.adsT > 0.15;

    /* ---------------- movimento ---------------- */
    this.movement.update(dt, _cmd);
    this.movement.readState(_state);
    _state.velocityY = this.movement.velocity.y;
    _state.weapon = ws.weapon;
    _state.adsT = ws.adsT;

    // Correr cancela recarga (e mira), como no Call of Duty.
    if (this.movement.state === 'correndo' && this.movement.planarSpeed > 5.2) {
      if (ws.reloading) ws.cancelReload();
    }

    /* ---------------- armas ---------------- */
    ws.setTrigger(firing && this.alive);
    // `_adsForcado` (ferramentas de captura/teste) vence o input, que sem
    // pointer lock chegaria sempre como false e cancelaria a mira no quadro
    // seguinte ao forceADS().
    ws.setADS((this._adsForcado ?? adsWant) && this.alive);
    ws.update(dt, _state);
    _state.adsT = ws.adsT;

    /* ---------------- câmera ---------------- */
    this.rig.update(dt, _state);
    if (ctx.camera) this.rig.applyTo(ctx.camera);
    if (ctx.viewCamera && ctx.camera) {
      // O viewmodel vive no espaço da câmera: mesma pose, FOV próprio.
      ctx.viewCamera.position.copy(ctx.camera.position);
      ctx.viewCamera.quaternion.copy(ctx.camera.quaternion);
    }

    /* ---------------- acao de uso (porta) ---------------- */
    // Depois da camera de proposito: a mira do quadro tem de ser a mesma que o
    // jogador esta vendo, senao a dica pisca um quadro atrasada.
    this._atualizarAcao(this.enabled && this.alive && !!input?.locked
      && input.wasPressed('use'));

    /* ---------------- viewmodel ---------------- */
    this.viewModel.update(dt, _state);

    /* ---------------- vida ---------------- */
    this._sinceDamage += dt;
    if (this.alive && this.health < this.maxHealth && this._sinceDamage > REGEN_DELAY) {
      this.health = Math.min(this.maxHealth, this.health + REGEN_RATE * dt);
      this.ctx.bus?.emit('player:health', { health: this.health, max: this.maxHealth });
    }
  }

  /* ================================================================ *
   * Acao de uso — a tecla que abre porta
   * ================================================================ */

  /**
   * Procura a porta que o jogador esta MIRANDO (nao "a mais perto"), publica a
   * dica na tela e aciona quando a tecla vem.
   *
   * Porque mira e nao raio: num comodo com porta de um lado e do outro, o
   * criterio "mais perto" abre a que esta atras das costas. O `alvoNaMira` do
   * WORLD faz travessia de raio contra a folha e ainda confere se ha parede no
   * meio — a folha vive fora do BVH, entao sem essa conferencia daria para
   * abrir a porta do vizinho atraves da parede.
   *
   * A dica so e emitida quando MUDA. Emitir por quadro encheria o EventBus com
   * 60 eventos/s so para reescrever o mesmo texto no DOM.
   *
   * @param {boolean} apertou a tecla de uso foi pressionada neste quadro
   */
  _atualizarAcao(apertou) {
    const portas = this.ctx.world?.portas;
    if (!portas || !portas.lista.length) {
      if (this._acaoRotulo !== null) {
        this._acaoRotulo = null; this._acaoAlvo = null;
        this.ctx.bus?.emit('player:acao', null);
      }
      return;
    }

    let alvo = null;
    if (this.alive && this.enabled) {
      this.getAimOrigin(_acaoOrigem);
      this.getAimDir(_acaoDir);
      alvo = portas.alvoNaMira(_acaoOrigem, _acaoDir);
    }

    if (alvo && apertou) portas.acionar(alvo);

    // `ang` muda durante o giro: le-se depois de acionar, para a dica ja trocar
    // de "abrir" para "fechar" no mesmo quadro do aperto.
    const rotulo = alvo ? (alvo.alvo > 0.01 ? 'fechar' : 'abrir') : null;
    this._acaoAlvo = alvo;
    if (rotulo === this._acaoRotulo) return;
    this._acaoRotulo = rotulo;
    this.ctx.bus?.emit('player:acao', rotulo
      ? { tecla: 'F', texto: rotulo === 'abrir' ? 'Abrir porta' : 'Fechar porta' }
      : null);
  }

  /* ================================================================ *
   * Dano e morte
   * ================================================================ */

  /**
   * Aplica dano ao jogador. Chamado pela IA.
   * @param {number} damage
   * @param {THREE.Vector3} fromDir direção MUNDIAL de onde veio o tiro
   */
  takeDamage(damage, fromDir = null, source = null) {
    if (!this.alive || damage <= 0) return this.health;
    this.health = Math.max(0, this.health - damage);
    this._sinceDamage = 0;
    this.rig.addShake(THREE.MathUtils.clamp(damage / 55, 0.12, 0.9), fromDir);

    this._emittingDamage = true;
    this.ctx.bus?.emit('player:damaged', {
      damage, fromDir, health: this.health, source,
    });
    this._emittingDamage = false;

    if (this.health <= 0) this._die();
    return this.health;
  }

  _die() {
    if (!this.alive) return;
    this.alive = false;
    this.weapons.enabled = false;
    this.weapons.setTrigger(false);
    this.weapons.setADS(false);
    this.rig.addShake(0.8);
    this.ctx.state = 'morto';
    this.ctx.bus?.emit('player:died', {});
  }

  /**
   * @param {{x,y,z}|null} pos posicao explicita; se omitida, sorteia um ponto de
   *   spawn valido do mundo. NUNCA cair no (0, 1.2, 0) antigo: a origem do mapa
   *   fica DENTRO do morro (o terreno vai de -3 a +36 m), entao renascer ali
   *   colocava o jogador embaixo da geometria, em queda livre infinita.
   */
  respawn(pos = null, yaw = 0) {
    this.alive = true;
    this.health = this.maxHealth;
    this._sinceDamage = 99;
    this.weapons.enabled = true;
    this.weapons.refill();

    let destino = pos, rumo = yaw, medirRumo = false;
    if (!destino) {
      const pts = this.ctx.world?.getSpawnPoints?.() ?? [];
      if (pts.length) {
        /* Renascer continua sendo sorteio (senao o jogador cairia sempre no
         * mesmo canto), mas sorteamos ALGUNS e ficamos com o de melhor vista.
         * Sem isso, uma morte em cada seis devolvia o jogador de cara no capim
         * ou olhando para o vazio fora do morro. */
        let melhor = null, melhorNota = -Infinity;
        for (let t = 0; t < 5; t++) {
          const s = pts[(Math.random() * pts.length) | 0];
          const q = s.position ?? s;
          if (!q || typeof q.x !== 'number') continue;
          const { nota } = this._avaliarPonto(q);
          if (nota > melhorNota) { melhorNota = nota; melhor = q; }
        }
        destino = melhor ?? (pts[0].position ?? pts[0]);
        // Nao usamos `s.yaw`: o yaw guardado em World.js esta 180° invertido
        // (mesma troca de sinal descrita em `yawPara`) e renascer de costas
        // para o mapa e tao ruim quanto nascer.
        medirRumo = true;
      }
    }
    if (destino) this.movement.teleport(destino.x, destino.y + 0.1, destino.z);
    else this.movement.teleport(0, 40, 0);   // ultimo recurso: acima de tudo

    if (medirRumo && destino) rumo = this._rumoInicial(destino);
    this.rig.reset(rumo, 0);
    this.ctx.bus?.emit('player:health', { health: this.health, max: this.maxHealth });
  }

  /**
   * Destrava o jogador entalado em geometria (casa sem saida, vao entre muros,
   * dobra de terreno) movendo-o para um spawn valido — e SO isso.
   *
   * Diferente de `respawn()`, que e a volta depois da morte e por isso zera
   * tudo: aqui vida, municao e recarga em andamento sao preservadas. Um
   * teleporte de emergencia nao pode valer cura completa e pente cheio, senao
   * vira o atalho barato para se curar no meio do tiroteio — o jogador pausa,
   * "destrava" e volta inteiro. O que ele ganha e sair do buraco, nada alem.
   *
   * A velocidade e zerada porque quem estava preso costuma estar acumulando
   * queda ou empurrao da colisao, e chegar no destino com isso guardado joga o
   * jogador longe no primeiro quadro.
   */
  destravar() {
    const vida = this.health;
    const desdeDano = this._sinceDamage;
    const municao = this.weapons.slots.map((s) => ({ ammo: s.ammo, reserve: s.reserve }));

    this.respawn();

    this.health = vida;
    this._sinceDamage = desdeDano;
    this.weapons.slots.forEach((s, i) => {
      if (!municao[i]) return;
      s.ammo = municao[i].ammo;
      s.reserve = municao[i].reserve;
    });
    this.movement.velocity.set(0, 0, 0);
    this.ctx.bus?.emit('player:health', { health: this.health, max: this.maxHealth });
  }

  /**
   * Rede de seguranca: se o jogador sair por baixo do mundo por qualquer motivo
   * (buraco na colisao, teleporte ruim), devolve-o a um spawn em vez de deixar
   * cair para sempre.
   */
  _checarQueda() {
    const y = this.movement.position.y;
    if (y > FUNDO_DO_MUNDO) return;
    console.warn(`[Player] saiu por baixo do mundo (y=${y.toFixed(1)}), reposicionando`);
    const pts = this.ctx.world?.getSpawnPoints?.() ?? [];
    if (pts.length) {
      const s = pts[(Math.random() * pts.length) | 0];
      const p = s.position ?? s;
      this.movement.teleport(p.x, p.y + 0.1, p.z);
    } else {
      this.movement.teleport(0, 40, 0);
    }
    this.movement.velocity.set(0, 0, 0);
  }

  /* ================================================================ *
   * Utilidades públicas
   * ================================================================ */

  /**
   * Força o estado de mira. Usado pelas ferramentas de captura e teste, que
   * não têm mouse — no jogo quem manda é o botão direito.
   */
  forceADS(v) {
    this._adsForcado = (v === null || v === undefined) ? null : !!v;
    this.weapons.setADS(!!v);
  }

  /** Direção de mira atual (unitária, sem bob). */
  getAimDir(out = new THREE.Vector3()) { return out.copy(this.rig.aimDir); }

  /** Origem do raio de tiro. */
  getAimOrigin(out = new THREE.Vector3()) { return out.copy(this.rig.worldPosition); }

  /** Alterna o modo de tiro da arma atual (o Input ainda não tem tecla dedicada). */
  cycleFireMode() { return this.weapons.cycleFireMode(); }

  /** Resumo para HUD/debug. */
  getStatus() {
    const ws = this.weapons;
    return {
      health: this.health,
      state: this.movement.state,
      speed: this.movement.planarSpeed,
      grounded: this.movement.grounded,
      weapon: ws.weapon.name,
      ammo: ws.ammo, reserve: ws.reserve,
      fireMode: ws.slot.fireMode,
      ads: ws.adsT,
      spread: ws.spread,
      surface: this.movement.surface,
    };
  }

  setQuality() { /* o viewmodel não muda com o preset — geometria é fixa */ }

  dispose() {
    for (const off of this._unbind) off?.();
    this._unbind.length = 0;
    this.viewModel.dispose();
  }
}

export { WEAPONS, LOADOUT, DIM };
