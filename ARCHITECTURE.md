# OPERAÇÃO CIDADE ALTA — Contrato de Arquitetura

FPS tático em Three.js ambientado numa favela brasileira ao entardecer.
**Este documento é o contrato.** Vários agentes trabalham em paralelo. Ninguém edita
arquivo fora do seu módulo. Ninguém muda assinatura pública sem atualizar aqui.

---

## Regras invioláveis

1. **Não edite arquivos de outro módulo.** Se precisar de algo, use o contrato existente
   ou registre a necessidade em `NOTES.md` (append-only, marque com seu nome de agente).
2. **Não instale dependências novas.** Só `three` e `three-mesh-bvh`. Zero assets externos —
   *tudo* é procedural (texturas, meshes, som). O jogo roda offline sem baixar nada.
3. **ES modules, sem TypeScript.** `import * as THREE from 'three'`.
4. **Nenhum módulo cria `THREE.WebGLRenderer`.** Só o `Engine`.
5. **Nada de `document.getElementById` fora de `src/ui/`.**
6. **Performance é requisito, não bônus.** Alvo: 60fps em 1920×1080 numa GPU integrada
   moderna. Instancie tudo que repete (`InstancedMesh`). Sem alocação por frame no
   `update()` — pré-aloque vetores temporários em escopo de módulo.
7. **Unidades: metros.** Altura do olho do jogador = 1.68. Gravidade = 9.81 m/s².
8. **Y é cima. -Z é o norte.** Mundo centrado na origem, ~180×180 m.

---

## Ciclo de vida — todo sistema implementa

```js
export class Sistema {
  constructor(ctx) {}        // ctx = GameContext (abaixo). Sem trabalho pesado aqui.
  async init() {}            // carga/geração pesada. Pode ser async.
  update(dt, elapsed) {}     // por frame. dt em segundos, já clampado a <= 0.05.
  dispose() {}               // libera geometrias/texturas/materiais.
}
```

## GameContext — o objeto compartilhado

Injetado no construtor de todo sistema. Definido em `src/core/GameContext.js` (dono: CORE).

```js
ctx = {
  renderer,        // THREE.WebGLRenderer
  scene,           // THREE.Scene   (mundo)
  camera,          // THREE.PerspectiveCamera (câmera do jogador)
  viewScene,       // THREE.Scene   (viewmodel de armas, renderizada por cima)
  viewCamera,      // THREE.PerspectiveCamera (FOV separado do viewmodel)
  clock,           // THREE.Clock
  bus,             // EventBus
  settings,        // Settings (presets de qualidade)
  input,           // Input
  assets,          // AssetRegistry — texturas/materiais compartilhados
  world,           // World  (preenchido pelo módulo WORLD)
  player,          // Player (preenchido pelo módulo PLAYER)
  ai,              // AIManager
  fx,              // FXManager
  audio,           // AudioEngine
  hud,             // HUD
  time: { dt, elapsed, frame },
  debug: { enabled, stats }
}
```

---

## EventBus — nomes de eventos (contrato entre módulos)

`ctx.bus.emit(nome, payload)` / `ctx.bus.on(nome, fn)` / `ctx.bus.off(nome, fn)`

| Evento | Payload | Emissor → Consumidor |
|---|---|---|
| `weapon:fire` | `{ weapon, origin:Vec3, dir:Vec3, spread }` | PLAYER → FX, AUDIO, AI |
| `weapon:hit` | `{ point:Vec3, normal:Vec3, surface:string, target:'world'\|'enemy', enemyId }` | PLAYER → FX, AUDIO |
| `weapon:reload` | `{ weapon, phase:'start'\|'magout'\|'magin'\|'end' }` | PLAYER → AUDIO |
| `weapon:switch` | `{ from, to }` | PLAYER → HUD, AUDIO |
| `weapon:state` | `{ ammo, reserve, name, fireMode, ads }` | PLAYER → HUD |
| `enemy:damaged` | `{ enemyId, damage, point:Vec3, headshot:bool }` | AI → FX, HUD, AUDIO |
| `enemy:killed` | `{ enemyId, headshot:bool, weapon, point:Vec3 }` | AI → HUD, AUDIO |
| `enemy:fire` | `{ enemyId, origin:Vec3, dir:Vec3 }` | AI → FX, AUDIO |
| `player:damaged` | `{ damage, fromDir:Vec3, health }` | AI → HUD, FX |
| `player:died` | `{}` | PLAYER → HUD, AI |
| `player:footstep` | `{ surface:string, position:Vec3, running:bool }` | PLAYER → AUDIO |
| `player:land` | `{ velocity:number, surface:string }` | PLAYER → AUDIO, FX |
| `game:start` / `game:pause` / `game:resume` | `{}` | UI → todos |
| `quality:changed` | `{ preset }` | UI → CORE, WORLD, FX |

**Superfícies** (string, usado por FX/AUDIO para escolher decal e som):
`'concreto' | 'tijolo' | 'metal' | 'madeira' | 'vidro' | 'terra' | 'asfalto' | 'agua' | 'folhagem' | 'carne'`

---

## Divisão de módulos (donos)

### CORE — `src/core/` *(agente: CORE)*
`Engine.js` `PostFX.js` `Sky.js` `Lighting.js` `GameContext.js` `EventBus.js` `Settings.js` `Input.js`

- `Engine`: renderer (WebGL2, ACESFilmic, `outputColorSpace = SRGBColorSpace`), duas cenas
  (mundo + viewmodel), resize, render target HDR (`HalfFloatType`).
- `PostFX`: cadeia própria em fullscreen quads (não usar `EffectComposer` padrão — precisamos
  de controle de MRT). Ordem: **SSAO → Bloom → Motion Blur → DOF → Tonemap+Grade → FXAA/TAA → Grain/Vignette/CA**.
- `Sky`: espalhamento atmosférico (Preetham/Hosek), sol posicionável, nuvens volumétricas
  baratas (raymarch de baixa amostra em cubemap atualizado a cada N frames).
- `Lighting`: **Cascaded Shadow Maps** (3–4 cascatas), IBL gerado do céu via `PMREMGenerator`,
  luz solar direcional + hemisférica. Expõe `Lighting.sunDirection`.
- API pública: `engine.render()`, `postfx.setQuality(p)`, `sky.setTimeOfDay(h)`, `lighting.update()`.

### MATERIALS — `src/world/materials/` *(agente: MAT)*
`TextureLab.js` `MaterialLibrary.js` `noise.js`

- Gera **PBR completo** (albedo + normal + roughness + AO + height) proceduralmente em
  `OffscreenCanvas`/GPU, 1024² ou 2048² conforme preset. Nada de `MeshBasicMaterial`.
- Superfícies obrigatórias: concreto sujo, tijolo aparente (o tijolo vermelho de 8 furos é
  *a* assinatura visual da favela), reboco pintado descascando, **telha de barro**,
  **telha de fibrocimento**, chapa metálica ondulada enferrujada, madeira compensada,
  asfalto molhado, calçada portuguesa (pedra preto-e-branca), terra batida, grafite.
- API: `MaterialLibrary.get('tijolo')` → `THREE.MeshStandardMaterial` (cacheado/compartilhado).
  `MaterialLibrary.getSurfaceType(material)` → string de superfície (para FX/AUDIO).
- Triplanar UV onde fizer sentido. Detail-normal em segunda UV para close-up.

### WORLD — `src/world/` *(agente: WORLD)*
`World.js` `Favela.js` `Buildings.js` `Props.js` `Vegetation.js` `Collision.js`

- Favela em encosta: casas de alvenaria empilhadas em níveis, becos estreitos, escadarias,
  lajes conectadas, gato de fiação elétrica cruzando o céu, caixas d'água azuis, varais com
  roupa, antenas parabólicas, muros com grafite, bar de esquina, kombi/fusca enferrujado.
- Geometria **modular e instanciada**. Merge agressivo de estáticos.
- `Collision`: BVH via `three-mesh-bvh` sobre uma malha de colisão simplificada (separada da
  visual). API: `world.collision.raycast(origin, dir, maxDist)` → `{hit, point, normal, surface, distance}`;
  `world.collision.capsuleSweep(start, end, radius, height)` → `{position, grounded, normal}`.
- `world.getSpawnPoints()` → array de `{position, yaw}`. `world.navGrid` → grid 2D de andável
  (`Uint8Array` + `worldToCell`/`cellToWorld`) consumido pela IA.

### PLAYER — `src/player/` *(agente: PLAYER)*
`Player.js` `Movement.js` `WeaponSystem.js` `Weapons.js` `ViewModel.js` `WeaponMeshes.js` `CameraRig.js`

- Movimento: andar/correr/agachar/deslizar/pular/mantle, aceleração e atrito no estilo CoD,
  inércia. Colisão por cápsula via `world.collision`.
- `CameraRig`: bob de passo, sway por mouse, tilt lateral, kick de recuo, shake de dano,
  **tudo em camadas somáveis com smoothing crítico** — nada de senoide crua.
- Armas (mínimo 3, geometria procedural detalhada, sem GLTF): fuzil (IA2/AR),
  submetralhadora, pistola. Cada uma com `{rpm, damage, falloff, spread, recoilPattern,
  magSize, reloadTime, adsTime, muzzleOffset}`.
- `ViewModel`: renderizado em `ctx.viewScene` com FOV próprio. Animações **procedurais**:
  idle sway, walk bob, sprint (arma abaixada e inclinada), ADS (lerp posicional + FOV),
  recuo (spring-damper), reload (curvas de keyframe em código), inspeção.
- Balística: hitscan com penetração por material + queda de dano por distância.
  Padrão de recuo determinístico (como CoD) + spread. Emite `weapon:fire`/`weapon:hit`.

### AI — `src/ai/` *(agente: AI)*
`AIManager.js` `Enemy.js` `Soldier.js` `NavGrid.js` `Perception.js`

- Mesh de soldado **procedural** com esqueleto real (`THREE.Skeleton`) e skinning; animações
  procedurais (caminhada, corrida, tiro agachado, morte com queda física simples).
- Máquina de estados: `IDLE → PATRULHA → ALERTA → PERSEGUIR → COBERTURA → ATIRAR → RECARREGAR → MORTO`.
- A* sobre `world.navGrid` com suavização de caminho e desvio local.
- Percepção: cone de visão + raycast de linha de visada + audição (reage a `weapon:fire`).
- Hitboxes por parte do corpo (cabeça 2.5×, torso 1×, membros 0.75×).
- Consome `world.collision` para linha de visada e busca de cobertura.

### FX — `src/fx/` *(agente: FX)*
`FXManager.js` `Particles.js` `Decals.js` `Tracers.js` `AudioEngine.js`

- Partículas em GPU (`InstancedMesh` + atributos, atualizado em shader ou por pool em CPU
  com budget fixo): fumaça de cano, faísca de impacto, poeira de concreto, lascas de tijolo,
  sangue, cartuchos ejetados (com física e som ao cair), fumaça de granada.
- `Decals`: buracos de bala projetados na geometria, pool circular com fade, atlas por superfície.
- `Tracers`: traçantes com estiramento por velocidade, aditivos, só em % dos tiros.
- Muzzle flash: geometria de flash + luz pontual pulsante de 1 frame.
- `AudioEngine`: **100% procedural via WebAudio**. Tiro = ruído + impulso filtrado + cauda de
  reverb convolvida (impulso gerado). Panning HRTF, oclusão simples por raycast,
  distância com filtro passa-baixa, eco de beco. Passos por superfície. Zumbido pós-tiro.

### UI — `src/ui/` *(agente: UI)*
`HUD.js` `Menu.js` `Killfeed.js` `DamageIndicator.js` `styles.css`

- HUD em DOM+CSS por cima do canvas (mais nítido que canvas 2D). Mira dinâmica que abre com
  spread, hitmarker, contador de munição, vida com vinheta de dano, bússola, killfeed,
  indicador de direção do dano, minimapa (render ortográfico de baixa res do navGrid).
- Menu: início, configurações (presets de qualidade, sensibilidade, FOV), pausa.
- Estética: sóbria, militar, alto contraste, sem "gamer neon". Fontes do sistema.

---

## Ordem de boot (`src/main.js` — dono: CORE)

```
Settings → Engine → Input → EventBus → MaterialLibrary.init()
→ Sky + Lighting → World.init() → Player.init() → AI.init() → FX.init() → HUD.init()
→ loop: input.update → player.update → ai.update → fx.update → world.update
        → lighting.update → hud.update → engine.render
```

## Presets de qualidade (`Settings.QUALITY`)

| | baixo | medio | alto | ultra |
|---|---|---|---|---|
| texturas | 512 | 1024 | 2048 | 2048 |
| sombras | 1024, 2 casc. | 2048, 3 casc. | 2048, 4 casc. | 4096, 4 casc. |
| SSAO | off | half | full | full |
| bloom | simples | simples | 5-tap | 5-tap |
| motion blur | off | off | on | on |
| partículas | 25% | 50% | 100% | 100% |
| resolução | 0.75× | 1.0× | 1.0× | 1.0× |

---

## Norte visual (a barra de qualidade)

Entardecer no Rio, sol raso e alaranjado a ~12° do horizonte, sombras longas e nítidas,
neblina de calor no vale, poeira suspensa nos raios. Contraste alto, pretos densos e
esmagados, realce quente e estourado. Referência de cor: teal-and-orange sutil, não
caricato. **Se parece um jogo de navegador de 2015, está errado.**

Erros que reprovam na hora: material liso/plástico sem variação de roughness; sombra dura
com aliasing; céu de gradiente chapado; geometria com cantos vivos perfeitos; textura
repetindo visivelmente em tiling; ausência de detalhe em escala pequena (sujeira, manchas,
desgaste em quinas); arma flutuando sem peso; iluminação plana sem oclusão de contato.
