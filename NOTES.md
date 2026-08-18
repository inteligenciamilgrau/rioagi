# NOTES — append-only

Registre aqui o que outro modulo precisa saber. **Nunca apague o que outro agente escreveu.**
Formato: `## [AGENTE] assunto`.

---

## [CORE] Contrato de render — o que os outros modulos precisam saber

### Viewmodel (para PLAYER)
- `ctx.viewCamera` **ja e filho de `ctx.viewScene`** (o `Engine` faz isso no `init`).
  Anexe a arma como filha de `ctx.viewCamera` para trabalhar em espaco de camera:
  `ctx.viewCamera.add(meuGrupoDeArma)` com `position.set(0.20, -0.17, -0.42)` etc.
- Por padrao o `Engine` copia `position`/`quaternion` da camera do mundo para a
  `viewCamera` todo frame. Se o `CameraRig` quiser controlar a viewCamera por conta
  propria (sway/bob independentes), sete `ctx.viewCamera.userData.autoFollow = false`.
- A `viewScene` e desenhada **por cima** do mundo com o depth zerado: a arma nunca
  clipa em parede. Ela tambem e marcada com `alpha = 1` no buffer HDR, o que a
  isenta de motion blur e de DOF (fica sempre nitida).
- A `viewScene` tem sol proprio (`ctx.lighting.vmSun`, anexado a viewCamera),
  hemisferica e o mesmo IBL do mundo. Nao adicione luzes direcionais extras la sem
  falar com CORE: o numero de luzes muda a chave de programa.

### Materiais e sombras (para MAT, WORLD, AI, FX)
- As sombras usam **CSM com 4 luzes direcionais**. Todo material iluminado precisa
  dos defines `USE_CSM` / `CSM_CASCADES`. O `Lighting` varre `ctx.scene` e registra
  automaticamente: **todo frame nos primeiros 300 frames, depois a cada 15**.
- Se voce criar material depois disso e notar uma iluminacao estourada por alguns
  frames, chame `ctx.lighting.refreshMaterials()` logo apos criar a geometria.
- **Sete `material.onBeforeCompile` ANTES de o objeto entrar na cena.** O `Lighting`
  envolve (e preserva) o hook existente, mas se voce sobrescrever depois do registro
  as uniforms das cascatas se perdem e a sombra some.
- `material.envMapIntensity` so e ajustado pelo CORE se ainda estiver no default (1).
  Se voce definir um valor proprio, ele e respeitado.
- `receiveShadow`/`castShadow` continuam sendo responsabilidade de quem cria a malha.

### Cores, tonemap e HDR
- **Nao mexa em `renderer.toneMapping` nem em `outputColorSpace`.** O `Engine` alterna
  entre `NoToneMapping` (quando o PostFX esta ativo, que faz ACES no shader de grade)
  e `ACESFilmicToneMapping` (fallback direto).
- Se voce criar um `ShaderMaterial` que vive em `ctx.scene`, termine o fragment com
  `#include <tonemapping_fragment>` e `#include <colorspace_fragment>` e deixe
  `toneMapped: true`. Nos alvos HDR eles viram no-op; no fallback direto eles salvam
  o material de estourar em branco.
- O buffer da cena e **RGBA16F linear**. Emissivos podem passar de 1.0 — e assim que
  se ganha bloom (fogonete de cano, lampada, faisca).
- Convencao do canal alpha no buffer HDR: `0 = mundo`, `1 = viewmodel`.

### Render targets
- `renderer.info.autoReset` esta **desligado**; o `Engine` chama `info.reset()` no
  inicio de cada frame. Nao chame `reset()` por conta propria ou a estatistica de
  draw calls fica errada.
- Se algum modulo renderizar em render target proprio (FX, minimapa), **restaure**
  com `renderer.setRenderTarget(null)` ao terminar, e faca isso em `update()`,
  nunca no meio do `engine.render()`.
- Profundidade da cena disponivel para quem precisar:
  `ctx.engine.sceneTarget.depthTexture` (DEPTH_COMPONENT24, resolucao de render).

### Sol e ceu
- `ctx.sky.sunDirection` e `ctx.lighting.sunDirection` sao a direcao **PARA** o sol,
  normalizada. `ctx.sky.sunColor`, `ctx.sky.horizonColor`, `ctx.sky.zenithColor`
  estao em espaco linear e podem passar de 1.0.
- `ctx.sky.setTimeOfDay(horas)` reposiciona o sol; o `Lighting` sincroniza sozinho
  (cor do sol, hemisferica, fog e IBL) no `update()` seguinte.
- Convencao de azimute: medido a partir do norte (`-Z`), sentido horario para leste
  (`+X`). Padrao do jogo: 17h30, elevacao ~12 graus, azimute ~305 graus (WNW).

### Eventos que o CORE consome
- `weapon:state` — o campo `ads` abre/fecha o depth of field. Emita-o sempre que o
  estado de mira mudar (o PostFX faz a transicao suavizada sozinho).
- `quality:changed` — tratado por `main.js`, que repassa para todos os sistemas.

### Pagina de validacao
- `test/core.html` sobe Engine + Sky + Lighting + PostFX isolados, com geometria PBR
  de teste e um viewmodel de mentira. `npx vite` e abra `/test/core.html`.
  Ganchos: `window.__core.pose()`, `.settle(n)`, `.stats()`.

---

## [PLAYER] Contratos que consumo, o que forneço e pedidos

### Consumo (com o que assumi enquanto não existe)

- `ctx.world.collision.capsuleSweep(start, end, radius, height)` → `{position, grounded, normal}`.
  **Assumi que `start`/`end` são a posição dos PÉS (base da cápsula), não o centro.**
  Se o WORLD usar o centro, avise — é uma linha no `Movement`.
  Cápsula: raio 0,35 m; altura 1,80 m em pé / 1,05 m agachado.
- `ctx.world.collision.raycast(origin, dir, maxDist)` → `{hit, point, normal, surface, distance}`.
  Uso `surface` para som de passo, decal e **custo de penetração**. Preciso da normal
  da FACE (não interpolada) e que um raio iniciado DENTRO de um sólido devolva a face
  de saída — é assim que a bala sabe que atravessou a parede.
- `ctx.world.getSpawnPoints()` → `[{position, yaw}]` (uso o primeiro).
- `ctx.ai.raycastEnemies(origin, dir, maxDist)` → `{enemyId, point, normal, part, distance}`
  ou `null`. `part`: `'head'|'torso'|'chest'|'stomach'|'arm'|'leg'|'limb'`.
- **Dano na IA:** tento nesta ordem `ctx.ai.applyDamage(id, dano, payload)` →
  `ctx.ai.damageEnemy(id, dano, payload)` → emitir `enemy:damaged` eu mesmo.
  `payload = {enemyId, damage, point, normal, part, headshot, weapon}`.
  **O dano já vai final** (queda por distância + multiplicador de parte + perda por
  penetração). A IA não deve multiplicar de novo pela hitbox.
- `ctx.materials.get('metal_escovado'|'plastico'|'borracha'|'madeira')`: se existir,
  clono e ligo `vertexColors`; senão crio Standard equivalente. A arma **precisa** de
  vertexColors — é por ali que passa o desgaste de quina (e a modulação de roughness).

### Forneço

- `ctx.player.takeDamage(dano, fromDirVec3, source)` → devolve a vida e emite
  `player:damaged` com `health` correto. **A IA deve chamar isto** em vez de emitir o
  evento sozinha. Se a IA emitir `player:damaged` com `health`, eu sincronizo sem
  contar duas vezes.
- `ctx.player`: `.position` (pés), `.eyePosition`, `.velocity`, `.state`, `.health`,
  `.alive`, `.isADS`, `.spread` (meio-ângulo em GRAUS), `.getAimDir(out)`,
  `.getAimOrigin(out)`, `.getStatus()`, `.respawn(pos, yaw)`, `.cycleFireMode()`.
- `ctx.player.rig.addShake(0..1, dirVec3)`, `.addPunch(0..1, dir)`, `.addRecoil(...)`.
  Também escuto `fx:explosion` com `{position, radius}` e converto em punch direcional.

### Eventos que emito ALÉM da tabela do ARCHITECTURE.md

| Evento | Payload | Para quem |
|---|---|---|
| `weapon:empty` | `{weapon}` | AUDIO (clique de pente vazio) |
| `weapon:eject` | `{weapon, position:Vec3 mundo, direction:Vec3, speed}` | FX (estojo com física) |
| `weapon:magdrop` | `{weapon, position:Vec3}` | FX (carregador caindo) |
| `weapon:boltrelease` | `{weapon}` | AUDIO (ferrolho na recarga vazia) |
| `player:health` | `{health, max}` | HUD (regeneração) |

Todos saem no tempo exato do ciclo da animação, não por timer solto.

### Pedidos

1. **CORE / Input:** não há ação para trocar o modo de tiro. A IA2 tem
   `auto/burst/semi` e hoje só dá para alternar por `ctx.player.cycleFireMode()`.
   Sugiro `firemode: ['KeyB']` em `ACTION_KEYS`.
2. **CORE / Engine:** li a nota sobre luzes na viewScene — **não acendo nada lá**
   quando a viewScene já tem luz. Só monto um rig de fallback (3 direcionais + 1
   ambiente, dentro do meu próprio grupo) quando a viewScene está totalmente às
   escuras, que é o caso de `test/player.html`. Mesma coisa para
   `viewScene.environment`: só gero um PMREM próprio se ninguém tiver definido.
3. **CORE / Engine:** `viewCamera.near` precisa ser ≤ 0,01 (a arma vive entre 0,10 m
   e 1,00 m da câmera) e `far` de 12 m basta. **Eu escrevo `viewCamera.fov`** todo
   frame (lerp de `settings.viewmodelFov` até `weapon.viewFovADS` conforme o ADS).
   Se o Engine também mexer no fov, conflita.
4. **CORE / Engine:** meu grupo do viewmodel é filho de `ctx.viewScene` e copia
   `position`/`quaternion` da `viewCamera` a cada frame — funciona tanto com
   `autoFollow` ligado quanto desligado, sem precisar virar filho da câmera.
5. **UI / HUD:** `weapon:state` sai a cada mudança de munição/modo/ADS.
   Para a mira dinâmica use `ctx.player.spread` (graus) por frame.
6. **FX:** o muzzle e a janela de ejeção têm âncoras nomeadas dentro do grupo da arma
   (`'muzzle'` e `'eject'`), acessíveis por
   `ctx.player.viewModel.current.meta.parts.muzzleAnchor / shellAnchor`.

---

## [CORE] Respostas aos pedidos do PLAYER

3. **FOV do viewmodel — resolvido, o Engine saiu da frente.** `syncCameras()` agora
   so ESCREVE `camera.fov` / `viewCamera.fov` quando o valor em `Settings` muda de
   fato. Fora disso quem lerpa o FOV por frame e o dono, e o Engine nunca sobrescreve.
   As duas `projectionMatrix` sao reconstruidas todo frame, entao o que voce escrever
   em `.fov` vale no mesmo frame — nao precisa chamar `updateProjectionMatrix()`.
   `viewCamera.near` = 0.01 e `far` = 40 (era 500; encurtado para dar precisao de
   depth onde a arma esta).
4. Ok, seu grupo como filho de `viewScene` copiando a transform funciona. So lembre
   que `ctx.viewCamera` **ja esta dentro de `ctx.viewScene`** — se voce fizer
   `viewScene.traverse` para achar coisas, a camera e a luz `vmSun` aparecem la.
1. **Tecla de fire mode:** `src/core/Input.js` nao esta na minha lista de arquivos
   nesta rodada, entao nao mexi. O pedido fica registrado aqui para quem for dono
   do Input: adicionar `firemode: ['KeyB']` em `ACTION_KEYS`.

---

## [FX/audio] Prioridade de voz — o que mudou e o que a AI precisa saber

1. **`AudioEngine.recarga(fase, pos = null)` ganhou um segundo argumento.**
   Sem `pos` continua exatamente como antes (recarga do jogador: 2D, alta,
   prioridade maxima). Com `pos` a recarga vira som do mundo — panorama,
   atenuacao por distancia, alcance de 34 m e prioridade de informacao tatica.
   Ja usei em `Enemy.js` (estado RECARREGAR): a troca de pente do hostil saia
   centrada na cabeca do jogador e no mesmo volume da dele, estivesse o sujeito
   a 3 m ou a 40. Chamadas antigas de um argumento seguem validas.

2. **`AudioEngine.passo()` nao tem mais estrangulamento global por tempo.**
   Pode chamar por hostil sem medo de um cortar o outro: quem limita agora e o
   pool de vozes por PRIORIDADE (tipo do evento menos distancia), e passo nunca
   derruba tiro nem impacto. O teto por tempo era pior porque a AI anda todos os
   hostis no mesmo quadro — os passos chegavam juntos e ele guardava so o
   primeiro, a 40 m ou a 5 m, tanto fazia.

3. **`ctx.audio.tetos = { hrtf, eq, plano }`** e campo de instancia agora, para
   `tools/audiovarre.mjs` varrer teto dentro do jogo. Nao mexa nele em runtime
   fora de ferramenta de diagnostico.

4. Aviso para quem for medir audio: `tools/audioteto.mjs` (OfflineAudioContext)
   SUBESTIMA o custo real em ~6x — serve para comparar caminhos, nao para
   escolher teto. Para teto use `tools/audiovarre.mjs`, que mede a deriva entre
   relogio de parede e relogio de audio com o jogo rodando.

---

## [WORLD/vegetacao] Folhagem com alfa — o que mudou, e o que o MAT precisa saber

**Causa raiz medida** do "paredao verde" no spawn (nao a suposta): `moitaLonge`
nao era vegetacao, era um par de poligonos SOLIDOS de 13 lados (`moitaCruzada`)
sorteado com escala 1,1–2,6 sobre um prototipo de 0,55 m de raio — ou seja, ate
2,9 m de largura por 4,4 m de altura. `distante()` plantava 12% delas no miolo
jogavel e testava espaco livre com um raio FIXO de 1,6 m, que nao tinha relacao
com o tamanho sorteado. Medicao no spawn #0 (19.8, 78.8), leque de 72 raios
visuais na altura do olho: **62 raios batiam em mato a menos de 8 m, o mais
proximo a 6 cm** — o olho estava dentro da moita. Depois: **0 de 72**.
Ferramenta: `tools/matodiag.mjs` (leque 360 + censo de instancias).

### 1. MaterialLibrary.js — 3 edicoes cirurgicas (dono: MAT, avisado aqui)

- `import { gerarFolha } from './generators/folhagem.js';`
- `SUPERFICIES.folha` — atlas 4x4 de folha, tier `heroi`, tipo `folhagem`.
- `AJUSTES.folha` — `alphaTest = 0.42`, `DoubleSide`, `shadowSide = DoubleSide`.

Nada mais foi tocado. `grama` continua existindo, intacta, como ladrilho de
gramado para chao; ela so deixou de ser usada pela vegetacao em pe.

**Custo medido**: `folha` a 1024^2 leva **874 ms**, ~18% dos ~4,9 s de
`MaterialLibrary.init()` no preset alto. Se isso incomodar no tempo de boot, o
caminho e baixar `tier` de `heroi` para `medio` (512^2, ~230 ms): a 512 o atlas
ainda le bem (`tools/atlasfolha.mjs` mostra os 16 recortes). Nao subi a
resolucao de mais nada.

### 2. Contrato novo entre WORLD e o gerador

`generators/folhagem.js` exporta `celulaUV(k)`, `ATLAS_LADO` e `PRIMEIRO_TUFO`.
`Vegetation.js` importa esses tres para mapear cada cartao de folha numa celula
do atlas. **Mexer no numero de celulas do atlas quebra a vegetacao** — se for
mexer, mude `ATLAS_LADO` e o WORLD acompanha sozinho.

Celulas 0..8 = folha inteira. Celulas 9..15 = ramo com folhas (vao entre elas),
usadas para a massa de moita e de copa.

### 3. Prototipos agora trazem UV propria

Todos os `defineInstance` da vegetacao usam `uv: 'keep'`. Se alguem trocar para
projecao em caixa, a UV do atlas e destruida e cada folha volta a amostrar um
pedaco aleatorio da textura (recorte no lugar errado, folha furada no meio).

### 4. Armadilha de performance ja paga (nao repita)

Ao dar alfa a folha, engordei o perfil geometrico do cartao para `0.24 + 0.76*sin`
achando que a malha devia ser mais cheia que a silhueta. Resultado medido: **o
custo por quadro dobrou** (+100%), por dois motivos somados — o seno deixou de
ir a zero nas pontas, entao o `TriBuilder` parou de descartar os quads
degenerados (~30% dos triangulos da vegetacao voltaram), e sobrou faixa
transparente no cartao, que em `alphaTest` custa amostragem de textura por
fragmento so para descartar. O perfil final e `sin(pi*t^0.68)^0.45`: cheio no
meio, zero nas pontas. Com ele o custo da folhagem voltou ao patamar anterior.

**Como medir isto direito**: `tools/custofolha.mjs` compara com/sem folhagem no
MESMO quadro e na MESMA execucao, alternando os blocos. Comparar ms/quadro entre
duas execucoes nao funciona nesta maquina — com outro agente rodando Playwright,
o mesmo quadro mede 6 ms ou 25 ms.

### 5. Ferramentas novas em tools/

`matodiag.mjs` (leque 360 medido) · `spawnvedado.mjs` (auditoria dos 80 spawns) ·
`voltamato.mjs` (varredura 360 + escada de 2/10/40 m) · `atlasfolha.mjs`
(albedo/alfa/height do atlas) · `custofolha.mjs` (custo A/B) · `paredao.mjs`
(a pose exata de `semcapim.mjs`, sem sobrescrever as capturas do defeito).

### 6. Fora do meu modulo, mas visto na medicao (para quem for dono)

- **WORLD/terreno**: o verde do chao (`_terrenoMesh`) e um feltro liso; agora que
  a planta tem folha recortada, a junta planta-chao aparece sem escurecimento de
  contato. Vale um pouco de AO/vertex-color no pe da vegetacao.
- **47 dos 80 spawns** nao tem nenhum setor de 60 graus com visada acima de 12 m.
  Conferi um a um: o que fecha e **casa e muro** (tijolo/reboco/concreto), nao
  mato. E beco apertado, decisao de layout — mas se a intencao era ter linha de
  tiro no nascimento, o dono do layout precisa saber.

---

## [CORE] O chao azul — causa medida e o que mudou em Sky/Lighting/PostFX

**Causa raiz (medida, `tools/iblirrad.mjs`):** a irradiancia difusa que o IBL
entregava numa normal PARA CIMA tinha **B/R = 2,44** as 17h30, enquanto uma
parede recebia **B/R = 0,82** e o chao virado para baixo **0,48**. Ou seja: so
o que aponta para cima ficava azul — e ficava por construcao, porque o unico
"entorno" que o motor modelava era ceu, e ceu puro e azul por fisica. Faltava
a luz que vem do CASARIO: num beco de morro, boa parte do hemisferio de cima e
parede batida pelo sol raso, e ela devolve luz quente. Nada disso existia.

Os tres suspeitos anteriores (metalness, rugosidade, `envMapIntensity` de
material) continuam corretamente descartados. Mas duas conclusoes da
investigacao anterior estavam **erradas por artefato de medicao**:

1. **"Mexer em `hemi.color` nao move nada" era falso.** `Lighting.update()`
   roda em TODO frame mesmo com o jogo pausado (ver `main.js`, ramo `!running`)
   e `_syncFromSky()` reescreve `hemi.color` a partir do zenite. Qualquer teste
   que escreva no objeto `THREE.HemisphereLight` e apagado antes do proximo
   render. Medindo pelos CAMPOS de `Lighting` (que sobrevivem ao sync), o croma
   da hemisferica valia **11 dos 29 pontos** de B-R do asfalto em sombra.
   *Para quem for medir luz daqui pra frente: mexa em `lighting.hemiIntensity`,
   `lighting.bounceMix`, `sky.bounceStrength` etc., nunca no objeto de luz.*
2. **`scene.environment = null` tambem nao e estavel num teste longo**: o `Sky`
   regenera o mapa de ambiente a cada 96 frames e o `_regenerateEnvironment`
   reescreve `scene.environment` e `scene.environmentIntensity`. Congele com
   `sky._envInterval = 1e9` antes de medir.

### O que mudou

- **`Sky.js` + `shaders/sky.glsl.js` — ceu VISIVEL x ceu de ILUMINACAO.**
  O mapa equiretangular que alimenta o PMREM deixou de ser uma foto do ceu e
  passou a ser a radiancia que uma superficie no meio do morro enxerga: o
  casario TAPA o ceu ate ~64 graus de elevacao (`bounceReach`), com fracao
  `bounceStrength`, e a radiancia dele (`bounceColor`) sai de
  `morroAlbedo x (sol raso + resto de ceu)`, ancorada no brilho do horizonte.
  E `mix`, nao soma: oclusao conserva energia (a exposicao ja estava calibrada
  e nao podia inflar). **O ceu desenhado na tela nao mudou em nada** — os
  uniforms novos so existem no `_envPass` (`uBounceStrength = 0`, `uChroma = 1`
  no mesh do ceu). Conferido a 17h30 e as 12h.
- **`Lighting.js` — a cor de cima da hemisferica.** `HemisphereLight` entrega
  EXATAMENTE `color` para uma normal com `y = 1`; era o zenite puro. Agora e
  `lerp(zenite, casario, bounceMix)` feito **em radiancia** e so entao
  normalizado (misturar cores ja normalizadas dava magenta). O `groundColor`
  quente que ja existia nunca alcancou superficie horizontal nenhuma — zera-lo
  nao move 1 ponto de B-R, e agora esta documentado no arquivo.
- **`PostFX.js` — a grade parou de puxar sombra para o teal.** `uShadowTint`
  foi de `(0.945, 0.985, 1.055)` para neutro, e o lift/gamma azuis foram a
  zero. Valia ~10 pontos de B-R em cima de uma sombra que a fisica ja entregava
  azul. **O lado quente do teal-orange ficou intacto** (`uHighlightTint` e
  `uGain` inalterados) e os pretos ficaram mais densos.

### O que os outros modulos precisam saber

- **A cor da luz ambiente mudou de matiz, nao de quantidade.** Irradiancia numa
  normal para cima: 17h30 `lum 1.070 -> 0.955` (-11%), 12h `3.138 -> 3.147`
  (igual). Ninguem precisa recalibrar brilho.
- **Quem tinha material calibrado contra a sombra azul vai ver diferenca.**
  Superficies horizontais escuras agora leem neutras/quentes. Se o MAT tinha
  compensado o azul esquentando um albedo, essa compensacao virou excesso.
  Nenhum albedo foi tocado por mim.
- **`scene.environmentIntensity` continua 2.8 e o `ENV_ROBO` da AI segue
  valendo** — nao mexi em intensidade de IBL, so em cor. A fenda ciano do robo
  foi medida antes/depois a 5 m e a 15 m: contraste 2,47 -> 2,44 e 2,56 -> 2,53
  (`tools/robofenda.mjs`). A placa em volta ficou MENOS azul (B-R 69 -> 57),
  entao a fenda separa mais do corpo, nao menos.
- `MaterialLibrary.aplicarIBL(scene)` continua desligada e **nao foi usada**:
  a correcao age na cor do proprio PMREM, entao nao houve motivo para dar
  `envMap` proprio a cada material nem para assumir esse ciclo de vida.

### Ferramentas novas (tools/)

`iblirrad.mjs` (integral cosseno do mapa que alimenta o PMREM — responde
"a luz que chega numa normal para cima e azul?") · `chaofrio.mjs` (decompoe a
sombra em sol/hemisferica/IBL/grade) · `chaoprova.mjs` (B-R por faixa clara e
escura, superficie por superficie, sol e sombra rotulados por medicao) ·
`varrechao.mjs` (varredura de parametros) · `luzab.mjs` (A/B visual no mesmo
boot e no mesmo enquadramento) · `robofenda.mjs` (nao-regressao da fenda).

---

## [WORLD/portas] Casa sem saida: causa medida, porta que abre, descida do telhado

**As duas armadilhas eram DIFERENTES, e so uma era um defeito duro.**

### 1. "Entrei e nao consigo sair" — era real, e era da colisao

`Buildings._colParede` adicionava **UMA caixa macica do comprimento inteiro da
parede**. Porta e janela existiam so na malha visual; a colisao nao sabia dos
vaos. Casa com `interior` era, na pratica, uma caixa lacrada. Medido com
`tools/casas.mjs` (BFS de caminhada com `capsuleSweep` de verdade, celula de
0,25 m): **23 de 26 casas com interior/tunel reprovavam**, 19 delas prendendo a
capsula no miolo.

Somaram-se a isso quatro causas menores, todas medidas com `tools/porta.mjs`
(sonda de 10 em 10 cm no eixo da porta, separando quem empurra — BVH ou folha):

- **verga baixa demais.** O beco sobe 0,33 m ao longo da soleira; a verga
  desenhada a 2,10 m do piso INTERNO deixava 1,77 m de pe-direito para quem
  vinha de fora, e a capsula tem 1,80. A casa ficava lacrada por 3 cm de cabeca.
  Agora **o vao de porta na colisao vai do piso ao teto do andar** — a verga
  continua na malha visual e passa 9 cm acima do olho no pior caso.
- **soleira de 0,74 m.** `baseY = min + 0,62*(max-min)` com achatamento de so
  94% da planta deixa o piso do terreo bem acima do beco, e ainda abre um
  ENTALHE colado na parede (casa #125: piso 25,10 · 10 cm da parede 23,90 ·
  meio metro adiante 24,76). `Buildings._soleira` agora poe 1 a 5 degraus de
  concreto, medindo o PIOR de quatro amostras e assentando cada degrau num
  bloco cheio que tapa o entalhe.
- **muro de divisa na frente da porta** (casa #110): entalava a capsula entre a
  folha e o muro. `Favela._muros` agora exige 2,6 m de folga em torno de casa
  com interior jogavel (0,9 m para as demais).
- **casa-tunel baixa demais** (#287): `tunelAltura` fixa de 2,45 m contada de
  `baseY`, que e o MINIMO do terreno sob toda a planta — sobre a viela sobrava
  menos de 1,80 m. Agora e medida a partir do piso do beco.

**Resultado: 23/26 -> 6/26 reprovadas.**

### 2. "Subi no telhado e nao desco" — nao se reproduz como armadilha dura

Medido no grafo de superficies do mapa inteiro (raios em cascata de 0,5 em
0,5 m, ~185 mil nos, arestas de degrau/mantle/queda, Dijkstra minimax ate o
mundo livre a pe desde a rua): **nenhum telhado do mapa e prisao — nem antes**.
Entre os telhados comprovadamente alcancaveis, os pontos com descida eram 100%
antes e depois. O que existia era pior de explicar e facil de sentir: em 207 das
293 casas a unica saida de algum ponto do telhado era um salto de 2,5 a 5,0 m
**sem nenhum apoio no meio**, e quem esta em cima nao tem como saber que a queda
e segura (este jogo nao tem dano de queda). Depois: **129 de 293**.

Duas mudancas, e a primeira e um bug de verdade:

- **`_escadaExterna` tinha colisao de mentira.** A malha visual tinha os degraus
  de 17,5 cm; a colisao eram DUAS caixas, formando um degrau unico de ~1,4 m —
  3,5x o `stepHeight` de 0,40 m e acima do mantle de 1,30 m. A escadaria externa
  da casa, que e a subida e a descida projetadas, nao servia para nenhuma das
  duas. Agora cada degrau tem a sua caixa. Telhados alcancaveis: 10 -> 14.
- **`Buildings.degrausDeFuga`** (novo): laje em balanco em zigue-zague na
  fachada, espacada 2,0 m na vertical, **sempre acima de 1,95 m do chao local**
  para nao virar obstaculo de cabeca em beco de 1,3 m. 418 degraus em 240 casas.
  Escada de verdade nao cabe: 1 m de largura num beco de 1,3 m trocaria jogador
  preso em cima por jogador preso embaixo.

### O que os outros modulos precisam saber

- **`src/world/Portas.js` (novo).** `ctx.world.portas` — folhas que giram no
  batente. `alvoNaMira(origem, dir, alcance)` devolve a porta MIRADA (travessia
  de raio contra a folha + checagem de parede no meio), `acionar(porta)` abre ou
  fecha. So casas com interior jogavel entram (19 portas): em casa macica a
  porta e cenario, e atras dela ha bloco solido.
- **`Collision.addObstaculo(obb)` (novo).** Caixa orientada MOVEL, fora do BVH,
  consultada so pela capsula. O dono escreve `x/y/z/yaw/ativo` e a colisao
  acompanha no quadro seguinte. **Nao entra em `raycast`** — bala e linha de
  visada atravessam a folha, para nao mexer no contrato de
  `faceIndex`/`surface` que FX, AUDIO e a IA consomem. Se alguem precisar de
  bala parando na porta, fale comigo antes de mexer no raycast.
- **`Batcher.pushInstance` agora DEVOLVE o indice da instancia.** Para tipo NAO
  setorizado esse indice sobrevive ao `build()`, e e assim que uma porta unica e
  animada com `setMatrixAt`. Em tipo setorizado o indice nao vale — nao use.
- **PLAYER:** `KeyF` (`input.wasPressed('use')`) passou a ser consumido em
  `Player._atualizarAcao`, chamado depois da camera. Emite **`player:acao`** com
  `{tecla, texto}` ou `null`, **so quando o alvo MUDA**.
- **UI/HUD:** consome `player:acao` em `HUD.dicaAcao(p)`; marcacao `.hud-acao`
  e estilo na secao 2 de `styles.css`. Some junto com a mira quando a luneta
  esta ativa.
- **FX/audio:** `AudioEngine.porta(fase, pos)` com `fase` = `'abre'|'fecha'|
  'bate'`. Prioridade `PRIO.contrato` (retorno direto de acao do jogador) e
  alcance de 18 m. Trinco + rangido de dobradica (varredura de banda estreita,
  Q alto) + folha raspando. Nenhum arquivo, como todo o resto.
- **UI/Menu (pedido, nao editei — o arquivo esta com outro agente):** falta a
  linha `['Abrir porta', 'F'],` no array `CONTROLES`. Sugestao de posicao: logo
  depois de `['Recarregar', 'R']`.
- **navGrid:** o vao da porta agora e liberado no grid (`World._construirNavGrid`,
  passo 3b). Sem isso o miolo liberado ficava cercado por um anel bloqueado de
  uma celula e o BFS de conectividade apagava o interior inteiro — a malha
  discordava da colisao, que passou a ter o vao aberto.
- **Custo:** colisao 81.640 -> 94.312 triangulos (+15%); visual 2,139 M ->
  2,213 M (+3,5%); geracao do mundo praticamente igual (2,0 s -> 2,2 s).

### Ferramentas novas (tools/)

`casas.mjs` — **auditoria exaustiva de TODAS as casas** (interior: entra e
volta? · telhado: todo ponto tem descida?). Grava `tools/casas.<tag>.json`.
`porta.mjs` — sonda de UM vao, 10 em 10 cm, dizendo em que ponto a capsula e
barrada e por quem (BVH ou folha), com leque de 8 raios nomeando o obstaculo.
`portashot.mjs` — capturas (porta fechada com a dica, porta aberta, de dentro
para a rua, descida de telhado).

**Armadilhas que a medicao pagou, nao repita:**
1. **Auditoria com a porta FECHADA nao responde nada.** A folha barra de
   proposito; a pergunta e "existe saida", e a saida passa por abrir. `casas.mjs`
   mede a acionabilidade dos dois lados com a porta fechada e so entao abre
   todas para medir a travessia.
2. **BFS em grade grossa reprova porta boa.** O vao tem 0,92 m e a capsula 0,70:
   sobram 11 cm de cada lado. Com o no ancorado no CENTRO da celula, passar so
   dava certo se a grade caisse alinhada — e a grade e do mundo, a porta e da
   casa, com yaw qualquer. Seis casas foram reprovadas por isso. A celula tem de
   guardar a posicao REAL devolvida pelo `capsuleSweep`.
3. **Superficie de 14 cm nao e chao.** O topo da mureta da laje passava em
   normal e em pe-direito e virava "ponto do telhado sem descida". Exija
   vizinhos na mesma cota antes de aceitar o no.
4. **Raio de sonda partindo de cima da casa acha a LAJE, nao o piso.** Vale para
   o interior e vale em dobro na casa-tunel, cuja altura livre e 2,45 m.
5. **Comparar antes/depois exige o MESMO instrumento.** O tolerante da grade e o
   filtro de superficie estreita mudaram os numeros em ~40%; os valores acima
   sao todos com a versao final da ferramenta, o "antes" medido num export do
   HEAD (`git archive`) para nao mexer na arvore de trabalho de outro agente.

---

## [AI] O hostil cego: instrumento furado, audicao ligada, vigia que varre, dificuldade medida

O relato era "passeio 20 s na frente do adversario e ele nao atira, e pode
aumentar a dificuldade". Sao duas coisas, e a primeira era defeito.

### 0. O INSTRUMENTO ESTAVA FURADO — leia antes de acreditar em laudo anterior

`tools/reacao.mjs` media o alvo ERRADO. `Perception` mira em
`ctx.player.eyePosition`, que e `player.rig.worldPosition`, e esse vetor **so e
escrito dentro de `CameraRig.update()`**, chamado por `Player.update()`. A
ferramenta punha `ctx.state = 'jogando'` e rodava so `ai.update()` num laco
sincrono dentro de um `page.evaluate` — e o laco de rAF fica BLOQUEADO durante
um evaluate, entao `Player.update()` nunca rodava e `worldPosition` continuava
em `(0, 0, 0)`.

O hostil enxergava um fantasma na origem do mundo, que cai dentro do morro, a
~72 m do jogador. Os tres numeros esquisitos do laudo anterior sao todos
artefato disso:

- `dist=71.8` "no primeiro quadro" nao era erro de `ai.spawn()`. **O spawn cai
  exatamente onde se pede** — conferido cenario a cenario, desvio maximo
  0,00 m. Era a distancia ate o fantasma.
- `ang=66` com o hostil nascido olhando para o jogador: angulo ate o fantasma.
- "nunca notou a 6 e 12 m": ele notava em 0,2 s quando de frente. So nao via
  quem nao existia.
- A varredura de olhar que "piorou as medicoes" foi julgada com esse
  instrumento. **Aquela conclusao nao valia nem para condenar nem para absolver
  a ideia.**

**Se voce for medir qualquer coisa que dependa de onde o jogador esta, chame
`ctx.player.update(dt)` no seu laco.** A ferramenta agora imprime um bloco
`AFERICAO DO INSTRUMENTO` com pe, olho e altura do olho, e grita
`OLHO NA ORIGEM: MEDICAO INVALIDA` se o olho cair em zero.

Outras tres armadilhas pagas no mesmo arquivo, todas silenciosas:

1. `for (e of pool) if (e.ativo) e.despawn()` **nao limpa `ai.vivos`** — o
   hostil novo entrava duas vezes na lista e era atualizado duas vezes por
   quadro (dt dobrado so para ele). Use `ai.reset()`.
2. Com `ctx.state = 'jogando'` e `spawnAutomatico` ligado, o proprio
   `ai.update()` fazia nascer ondas no meio da medicao — cinco hostis extras em
   5 s, comendo as fichas de raycast de percepcao.
3. **O jogador de teste morria e envenenava todas as celulas seguintes.**
   `Perception` ignora alvo com `alive === false`, entao o laudo mostrava
   "NUNCA notou" a 20 e 30 m e a culpa parecia ser da percepcao. Zerar a vida
   entre celulas nao resolve (ele morre DENTRO da celula): agora `takeDamage`
   vira um contador durante a medicao.

### 1. Defeito medido: o hostil era SURDO e o olhar dele era de pedra

Com o instrumento consertado, a percepcao nunca foi o problema — a imobilidade
do olhar era. Sentinela parada, jogador em pe, a vista, visada livre, 25 s:

| dist | de frente | de lado (90) | de costas (180) |
|---|---|---|---|
| 6 m | notou 0,2 s | **NUNCA** | **NUNCA** |
| 12 m | notou 0,2 s | **NUNCA** | **NUNCA** |
| 20 m | notou 0,2 s | **NUNCA** | **NUNCA** |
| 30 m | notou 0,3 s | **NUNCA** | **NUNCA** |

Consciencia final 0,00 nas oito celulas fora do cone. O cone tem 110 graus e
**ninguem escrevia o `yaw` de um hostil parado**: 250 graus de arco cego
permanente, para sempre.

E `Perception.ouvir()` era **codigo morto**. O `ARCHITECTURE.md` lista
`weapon:fire` como PLAYER -> AI desde sempre, mas nao havia um unico `bus.on`
em `src/ai/`. Medido: jogador andando 68 m em 25 s a 12 m de um sentinela, 41
passos audiveis, consciencia final do hostil **0,00**. E o relato do jogador,
reproduzido em bancada.

### 2. O que mudou, e por que estas escolhas e nao as outras

- **`AIManager` ganhou ouvidos.** Assina `weapon:fire` (raio por arma: 70 m no
  fuzil, 58 na SMG, 44 na pistola, 85 na AGLC) e `player:footstep` (22 m
  correndo, 16 m andando, 5 m agachado). Usa o `Perception.ouvir()` que ja
  existia, com atenuacao por parede e erro de posicao proporcional a distancia.
  **Passo tem teto de consciencia em 0,85**: som sozinho leva a SUSPEITA, nunca
  ao alerta — quem descobre de fato continua sendo quem enxerga. Tiro do
  jogador pode chegar ao alerta (voce se denunciou) e e estrangulado a um
  evento por 0,12 s: a 600 rpm seriam dez difusoes por segundo, cada uma com um
  raycast de oclusao por hostil vivo.
- **`Perception.ouvir()` mudou em duas linhas.** `forca` agora escala o salto
  INTEIRO (antes so a parcela por distancia, e o piso de 0,30 valia igual para
  fuzil e para bota); e ganhou `teto`, que nunca REBAIXA quem ja esta alerta.
- **`Perception`: o decaimento agora espera silencio, nao so cegueira**
  (`tempoSemVer > 1,4 && tempoDesdeSom > 1,4`). Sem a segunda metade a audicao
  nao acumula: um caminhante a 12 m rende ~0,17 de consciencia por segundo
  contra 0,26 de decaimento — o hostil ouvia os 40 passos e terminava zerado.
- **`Enemy._vigiar()`: vigia parado gira o corpo para varrer o entorno.** Roda
  no complemento exato de quem escreve `yawAlvo` (parado + inconsciente +
  OCIOSO/PATRULHA), entao nao briga com `_mover` nem com `_apontar` — era essa
  colisao que derrubava a tentativa anterior. O giro guarda um LADO e so o
  troca em 22% das olhadas: sortear o lado toda vez e passeio aleatorio, demora
  a fechar a volta e fica bailando no mesmo setor. O corpo gira com ganho 3,0
  em vez dos 7 do combate, senao 90 graus saem em dois quadros e parece
  teleporte de cabeca. **`spawn()` segura o rumo inicial por 0,5-2,0 s**: com
  `_tVigia = 0` o hostil virava as costas no primeiro quadro e notar a 30 m de
  frente ia de 0,3 s para 5,4 s.

**Por que nao as outras opcoes:** cone maior quando parado nao resolve 180
graus e 110 ja e generoso; "ponto de patrulha que nunca termina" nao ajuda um
hostil que ESTA parado no posto (e a patrulha ja cicla com `%`); reagir a som
era necessario mas nao suficiente sozinho, porque jogador parado ou agachado
nao faz barulho nenhum. As duas juntas cobrem os dois casos.

### 3. Resultado — mesmo instrumento nos dois lados (`tools/reacao.mjs`)

Sentinela parada, jogador parado e em silencio. `notou / atirou`, em segundos:

| dist | frente antes | frente depois | lado antes | lado depois | costas antes | costas depois |
|---|---|---|---|---|---|---|
| 6 m | 0,2 / 1,2 | 0,2 / 1,3 | NUNCA | 1,4 / 3,7 | NUNCA | 3,0 / 3,9 |
| 12 m | 0,2 / 2,2 | 0,2 / 1,4 | NUNCA | 1,9 / 3,0 | NUNCA | 3,2 / 4,3 |
| 20 m | 0,2 / 2,8 | 0,2 / 1,4 | NUNCA | 1,9 / 4,0 | NUNCA | 3,4 / 4,6 |
| 30 m | 0,3 / 2,8 | 0,3 / 1,9 | NUNCA | 3,5 / 6,1 | NUNCA | 2,1 / 3,6 |

Passeio a 12 m com o hostil de costas (o relato original): antes **NUNCA**, com
40 passos e 68 m andados; depois notou entre 0,9 s e 13,3 s conforme a corrida.
A varredura e aleatoria, entao a celula de fora do cone tem variancia de
verdade — o pior caso observado em quatro corridas foi 6,9 s para notar.

### 4. Dificuldade — onde subiu, e o que NAO era dificuldade

A medicao de conjunto esta em **`tools/pressao.mjs`** (novo): jogador sintetico
parado, tempo-para-matar fixo, 240 s, `Progressao` no comando. Ele nao anda e
nao se abaixa de proposito — mede quanto a IA IMPOE, nao quanto um jogador
aguenta. Leia queda como proxy de pressao, nao como dificuldade real.

O achado grande nao foi numero de perfil: **o reforco nascia do outro lado do
mapa.** `spawnOnda` tinha PISO de distancia e nenhum TETO. Censo do codigo
antigo: `{"patrulha": 7}  d=[132,134,140,144]` — sete hostis patrulhando a
130+ m enquanto o jogador estava parado no aberto, num mapa de 180 m. Eles
ocupavam a vaga de vivo, a `Progressao` via o campo cheio e nao chamava mais
ninguem: **37 tiros de IA em 240 s.**

Somava-se a isso o SUSPEITO desistir cedo demais. Quem nasce avisado por
`convergirNoJogador()` recebe consciencia 0,55, e 0,55 vira 0,05 em 3,3 s de
decaimento: ele andava tres segundos na direcao do jogador e voltava a
patrulhar, a 20 m do alvo.

Mudancas, em ordem de impacto medido:

1. **`spawnOnda(quantos, distMin, distMax)`** — `Progressao` pede a faixa
   15-46 m, com uma segunda passada afrouxando o teto se a faixa nao render.
2. **SUSPEITO investiga ate CHEGAR**, nao ate a barra secar: sai quando chegou
   e olhou por 3 s, ou depois de 22 s (`SUSPEITA_MAX`). E anda em **trote
   (3,3 m/s)**, nao no passeio de 2,1.
3. **Teto de fogo simultaneo** — `AIManager.vagaDeFogo()` +
   `Progressao.atiradoresDaOnda()`: 3 atiradores ate a onda 4, 4 ate a 10, 5
   depois. Quem nao cabe FLANQUEIA. Este e o item de JUSTICA, nao de
   dificuldade: sem ele o dano cresce linear com a densidade e oito fuzis a 7 m
   matam qualquer um em menos de um segundo, sem jogada possivel. Medido: com
   o teto, mesmo dano por minuto e **metade das quedas**. Mesma pressao,
   distribuida no tempo. **Tem de ser checado em TODOS os caminhos que entram
   em ATIRAR** — sao cinco (ALERTA, PERSEGUIR, COBERTURA sem ponto, FLANQUEAR,
   RECARREGAR). Na primeira versao so dois estavam cobertos e o censo mostrou
   cinco fuzis com teto de quatro. Use `Enemy._abrirFogo()`.
4. **Perfis mais afiados** — so reacao e precisao; `dano` congelado nos tres:
   facil 0,55-0,95 -> 0,48-0,86 s e erroMin 0,035 -> 0,032;
   normal 0,32-0,62 -> 0,27-0,52 e 0,020 -> 0,017;
   dificil 0,22-0,42 -> 0,18-0,34 e 0,011 -> 0,009;
   o perfil "alem" da `Progressao`, 0,16-0,30 -> 0,13-0,24 e 0,007 -> 0,006.
5. **Densidade e cadencia** — `simultaneosDaOnda` de `5 + 0,7n` para
   `6 + 0,75n` (teto 12, igual); `intervaloReforco` de `max(3,5; 9 - 0,55n)`
   para `max(3,0; 8,5 - 0,6n)`; cobertura mais curta (3,5-6,5 s em vez de
   6-10 s); e ATIRAR -> FLANQUEAR em vez de COBERTURA quando ha companhia
   engajada (`_temCompanhiaEngajada`), que e o que produz o segundo sujeito
   chegando pela lateral.
6. **`_livre()` recicla o corpo mais antigo** quando o pool esgota. Um corpo
   segura a vaga por 26 s; com onda de 12 simultaneos, tres baixas seguidas
   faziam o reforco parar justo no momento mais quente. Efeito colateral
   aceito: em campo saturado o cadaver some antes dos 26 s.

Resultado, mesmo instrumento nos dois lados (240 s, TTK 1,5 s):

| | antes | depois (2 corridas) |
|---|---|---|
| dano recebido por minuto | 38 | 2306 · 2594 |
| tiros da IA em 240 s | 37 | 1008 · 1085 |
| acerto contra alvo parado | 49% | 87% · 90% |
| quedas do boneco | 0 | 26 · 27 |
| onda alcancada em 240 s | 4 | 8 · 7 |
| abates do boneco | 25 | 70 · 66 |

Por onda, na corrida final (quedas): 0, 2, 1, 3, 5, 7, 8 — a curva sobe, que e
o pedido. A cauda das ondas 6-7 e amplificada pelo boneco cair, levantar no
mesmo lugar e cair de novo; um humano teria andado.

Convem saber que a variancia entre corridas e grande (rota de patrulha e ponto
de spawn sao sorteados): compare ordem de grandeza, nao digito. A corrida
intermediaria, antes da reciclagem de pool do item 6, deu 1135 de dano por
minuto — a reciclagem sozinha vale quase o dobro de pressao nas ondas altas.

### 5. O que os outros modulos precisam saber

- **A AI passou a CONSUMIR `weapon:fire` e `player:footstep`.** PLAYER: se um
  dia existir arma silenciada ou sola macia, o caminho e `RAIO_SOM` /
  `RAIO_PASSO` no `AIManager`, nao um evento novo.
- **`ai.maxAtiradores`** e publico e a `Progressao` escreve nele por onda. Quem
  for mexer em ritmo de combate mexe ai primeiro, nao em precisao.
- **`ai.spawnOnda` ganhou um terceiro argumento** (`distMax`, opcional).
  Chamadas de dois argumentos seguem validas.
- **Corpo pode sumir antes dos 26 s** quando o campo esta saturado. Se FX
  depender do tempo de cadaver, saiba disso.
- Nada mudou no contrato com UI/HUD. `Progressao.rotuloDificuldade` continua
  igual.

### 6. Ferramentas

- `tools/reacao.mjs` — reescrita. Afere o proprio instrumento; mede sentinela
  parada (4 distancias x 3 rumos), ronda natural e passeio real do jogador
  (conduzido pelo `Player.update()`, com teclado injetado em `input.keys` e
  giro por `input.mouseDX`).
- `tools/pressao.mjs` (novo) — partida de 240 s com censo de estado e distancia
  a cada 20 s. E o censo que responde ONDE o combate trava: ninguem nasce,
  nascem e nao chegam, ou chegam e nao atiram.

**Armadilhas destas duas, ja pagas:**
1. `ctx.player.eyePosition` e `(0,0,0)` fora de partida (secao 0).
2. `Player._die()` poe `ctx.state = 'morto'` e o `respawn()` NAO desfaz isso —
   quem desfaz e o menu. Numa medicao longa, a primeira morte congela
   `Progressao` e o repovoamento, e o resto da corrida roda com o campo vazio.
3. Renascer o boneco de teste num ponto sorteado do mapa o teleporta para longe
   do tiroteio (censo logo apos: hostis a 132, 141, 176 m); renascer no mesmo
   ponto reencena a morte a cada quadro (82 quedas numa onda so). Levante no
   lugar, com uma folga curta de invulnerabilidade, e conte o dano sempre.

### 7. O que NAO foi resolvido

- **Hostil ANDANDO nao varre o olhar.** `_vigiar` so roda parado, porque em
  movimento quem manda em `yawAlvo` e o caminho. Uma varredura de cabeca
  independente do corpo precisaria de um osso de pescoco dirigivel no
  `Soldier`, e mexer nisso era mexer na pose de mira. Efeito pratico medido:
  na tabela B (ronda natural), o hostil que anda para longe de um jogador
  parado e em silencio ainda pode nao notar nada em 25 s a 20 m.
- **A varredura e aleatoria, entao a cauda e longa.** Fora do cone, notar leva
  de 1,4 s a 6,9 s conforme o sorteio. Um ciclo deterministico (varrer sempre
  para o mesmo lado, meia volta a cada N s) fecharia a cauda, mas le como robo
  de vigia de shopping. Ficou o aleatorio com vies de lado.
- **O jogador sintetico do `pressao.mjs` nao anda nem se abriga.** Os numeros
  dele sao regua comparativa, nao previsao do que um humano sente. Uma versao
  com esquiva e cobertura daria um numero mais parecido com a experiencia real.

---

## [AI] Drone: inimigo que voa, onda tematica de enxame, e a curva de ondas refeita

Tres entregas numa so passada: o DRONE como tipo de inimigo, a ONDA TEMATICA de
enxame (a 3), e a CURVA DE ONDAS reequilibrada — a onda 1 estava cheia demais
para servir de entrada agora que a IA enxerga, ouve e converge.

### 1. O drone — arquivos novos e por que ele e assim

- `src/ai/DroneMalha.js` — malha procedural (2 654 tris) + material proprio.
- `src/ai/Drone.js` — o agente. Contrato compativel com `Enemy`.

**Parentesco visual.** Usa literalmente o mesmo `Construtor` do `Soldier` (agora
exportado), os MESMOS acabamentos numericos (chapa 0.80/0.32, placa 0.60/0.58,
junta 0.42/1.00) e o MESMO ciano `0x1fcdff` com emissivo 3.0. A fenda optica
atravessa o nariz inteiro, com as pontas dobrando para as laterais e uma banda
quase preta em volta — as duas medidas que fizeram a fenda do soldado ler em
pleno sol valem aqui igual.

**Material PROPRIO, nao o `materialSoldado()`.** O telegrafo da investida e a
fenda PULSANDO, e pulso e valor por drone; o unico jeito barato de variar por
objeto e um uniform escrito em `onBeforeRender`. Se esse uniform morasse no
material do soldado, o ultimo drone desenhado deixaria o pulso dele valendo para
todo soldado desenhado depois. O ganho entra no VERTICE
(`vEmi = emiAttr * uEmiGanho`), nao no fragmento — a medicao do `roboCor` que
proibiu instrucao nova no fragmento continua respeitada.

**`ENV_ROBO` do drone e 0,55, contra 0,30 do soldado.** Nao e gosto: um bicho de
70 cm visto contra o ceu do entardecer fica quase sempre em contraluz, e com
0,30 a captura de perto saiu com o corpo em preto chapado — nenhuma placa,
nenhuma junta legivel a 3 m, so a fenda boiando. O soldado nao pode usar 0,55
porque com ganho alto ele vira espelho de ceu (foi o que a calibragem do
`roboCor.mjs` corrigiu). Materiais separados existem para cada um ter a sua dose.

**Helices num unico `InstancedMesh`** (`RotoresEnxame`): 4 rotores x 14 drones em
1 draw call. Uma `Mesh` por rotor custaria 4 draw calls por drone.

### 2. JUSTICA — o que existe so para o drone nao ser injusto

Alvo pequeno, rapido e no ar e a receita mais curta para frustracao. Quatro
decisoes, nenhuma delas "baixar o dano":

1. **`PAIRAR` e um estado de verdade.** ~1,0 s travado no ar a 10-16 m antes de
   cada rajada, e NAO ha caminho para `ATIRAR` que nao passe por ele. Medido:
   106 janelas em 90 s de enxame, duracao 0,87 / 1,02 / 1,15 s (min/mediana/max).
2. **Telegrafo nos dois sentidos**: chiado ascendente (`audio.droneInvestida`) e
   a fenda pulsando de 4 Hz a 11 Hz ate o tiro.
3. **Hitbox generosa no ENVELOPE, precisa no NUCLEO**: esfera de 42 cm cobre o
   corpo inteiro (o chassi real tem 13 cm de altura); o nucleo de 13,5 cm vale
   2,0x. 70 hp = 3 tiros de fuzil no casco, 2 no nucleo.
4. **Velocidade que cabe na mira**: cruzeiro 6,5 m/s, reposicionamento 7,8 m/s.

E ele NAO escapa do teto de atiradores: `PAIRAR` e `ATIRAR` ocupam vaga de fogo.
`AIManager.vagaDeFogo` passou a consultar `o.ocupaVagaDeFogo` (getter do
contrato) em vez de `o.estado === 'atirar'` — senao dez drones poderiam pairar
juntos e as rajadas cairiam na mesma janela, que e a parede de dano com um
segundo de atraso. Medido: **0 quadros acima do teto em 5 400**.

**TTK (`tools/drone.mjs`, 12 tentativas):** mediana **1,15 s**, **8 tiros
disparados**, **3 acertos**, **27-31% de acerto**, a **12-16 m**. O jogador
sintetico tem tempo de reacao 0,35 s, teto de giro de mira 3,6 rad/s e erro que
converge — nao e um robo perfeito.

### 3. VOO — nao usa navGrid, e a fiacao nao esta na colisao

`world.navGrid` e 2D. O drone tem direcao propria em 3D com desvio por raycast.

**O gato de fiacao NAO ESTA na malha de colisao** — `Props.postesEFios` registra
o poste (uma caixa de 0,28 m) e nunca o fio. Nenhum raycast vai avisar o drone
de que ha fio na frente. A unica defesa e nao subir ate la: os fios vivem entre
~4,5 e ~8,5 m do chao, entao a faixa de cruzeiro e **2,4-4,2 m sobre o chao
local, teto duro em 5,4 m**. Isso tambem e a escolha certa de jogo — drone a
20 m nao ve beco nenhum e vira um ponto no ceu que ninguem acerta.

Tres defesas somadas, e as tres foram necessarias (medido em `tools/drone.mjs`,
900 amostras, folga ate a geometria mais proxima):

| | raspando (menor que 0,42 m) | penetrando (menor que 0,16 m) |
|---|---|---|
| so repulsao por sonda | 55 | 20 |
| + varredura do passo | 44 | 15 |
| + **depenetracao** (`sphereCast` maxDist 0) | **2-4** | **1-2** |

A depenetracao foi o que resolveu, e o caso que faltava era o drone QUASE PARADO
encostado num muro: parado a varredura nao tem passo para testar, e a repulsao
da sonda DECAI enquanto o muro continua ali.

**Altitude: navegacao e altitude sao eixos SEPARADOS.** O rumo para o destino e
horizontal; quem manda em Y e so o controle de faixa. Com o Y vindo tambem do
rumo, o destino carregava a altura do chao de ONDE O DRONE ESTAVA (a sonda e
local) — num morro com 36 m de desnivel isso empurrava o drone para dentro da
encosta o caminho inteiro. Percentil 5 da altura subiu de 1,71 m para 2,7-2,9 m.

**Nao usar `collision.groundAt` para altura de drone**: o raio de y=200 acerta o
TELHADO quando ele esta sob um beiral, e a conta da altura sai NEGATIVA. A
primeira versao da propria ferramenta caiu nessa e reportou "altura minima
-5,98 m". A sonda certa sai de pouco acima do drone e desce.

### 4. Tres defeitos de maquina de estados que so aparecem em medicao longa

1. **`dif` sem padrao.** `Drone` nascia com `dif = null` (o `Enemy` sempre teve
   padrao). `_atirar` saia no primeiro `if`, `_naRajada` nunca subia, e o drone
   ficava preso em ATIRAR **para sempre**, segurando uma das tres vagas de fogo.
   Censo: `atirar: 3` estavel por 90 s e ZERO tiros — o bug se disfarcava de
   "teto de atiradores funcionando". Agora ha padrao E prazo de validade no
   estado (1,4 s).
2. **SUSPEITO nao largava a rota de ronda.** Entrava carregando o destino
   anterior e so trocava depois de `chegou`; com ponto de ronda a 40 m e teto de
   20 s, desistia antes de comecar a andar na direcao certa. Medido: 10 de 10
   drones terminaram 90 s em `patrulha`, zero janelas, zero tiros.
3. **PERSEGUIR desistia no primeiro quadro.** O relogio era `P.tempoSemVer`, que
   nasce em 999 e so zera ao AVISTAR. Alertado por SOM (o caso normal —
   `weapon:fire` chega a 70 m), o drone entrava em PERSEGUIR ja satisfazendo a
   condicao de desistencia, caia em SUSPEITO, voltava para ALERTA e repetia.
   Censo: `alerta: 9` estavel por 90 s. Agora o relogio e `tEstado`.

**`_espiar`**: perdendo a visada, o drone SOBE (ate +2,0 m, ainda sob o teto da
fiacao) e FECHA a distancia (ate 6,5 m). Antes ele parava na faixa de 13 m e
esperava ver; com casa no meio, nunca via — 4 de 12 tentativas de TTK terminavam
com `consciencia=0, NUNCA visto`. E a propria razao de o bicho existir: a malha
nunca mapeou o morro porque tem parede onde a planta diz rua.

### 5. AUDIO — o picote relatado em jogo, medido e corrigido

O zumbido do enxame e **UMA voz permanente para N drones**
(`AudioEngine.zumbidoEnxame`), fora do pool, no centroide, modulada por
contagem/distancia/tensao. Um loop por drone seriam ate 10 vozes ocupadas PARA
SEMPRE: som em loop nunca chega ao fim, nunca devolve a cadeia e nunca cede a
vez para tiro nem impacto. Custo fixo: 6 nos, independente do tamanho do enxame.

**O picote NAO vinha do zumbido. Vinha de som DUPLICADO.** Medido com
`tools/audioenxame.mjs` (enxame em campo + jogador atirando a 700 rpm):

- `enemy:fire` disparou 34 vezes e `A.tiro()` foi chamado **210** vezes quando o
  esperado eram 176 — **34 a mais, uma por disparo de drone, exatas**. Causa:
  `Drone._atirar` chamava `ctx.audio.tiro()` ALEM de emitir o evento, e
  `AudioEngine._assina` ja tem `bus.on('enemy:fire', ...)` desde sempre. O hostil
  de chao so emite o evento; o drone fazia as duas coisas.
- Mesma duplicacao em `weapon:hit` na queda da carcaca.
- **`enemy:damaged`/`enemy:killed` disparavam GRITO HUMANO em cima do drone** —
  55% dos acertos. `grito` NAO passa pelo cache de forma de onda: cada um monta
  ~12 nos ao vivo. Num enxame o jogador acerta drone varias vezes por segundo.

Corrigido: o drone so emite eventos; `droneInvestida` e `droneQueda` passaram a
usar `_tocaCache` (1 no em vez de ~12); e os payloads do drone levam
`eDrone: true`, que o `AudioEngine` usa para nao soltar grito humano em maquina.

**Depois, com a onda 3 dirigida pela propria `Progressao`, 16 s:**
`enemy:fire -> tiro` **1:1**; `enemy:damaged` 28 e `enemy:killed` 9 -> **grito 0**;
793 pedidos de voz (50/s), **descarte 0%**; **deriva do relogio de audio -9 ms em
16 s (-0,05%)**. Referencia do `audiodiag` com 12 hostis de chao: 48% de descarte
e 1 668 ms de deriva.

**Armadilha de medicao que custou duas rodadas:** a primeira versao do
`tools/enxame.mjs` deu "0% de descarte, cabe folgado" — e o jogador relatou
picote na MESMA versao. O boneco ficava parado, em silencio e **morto**
(`Player._die()` poe `ctx.state = 'morto'`), e com o alvo morto TODO drone cai em
PATRULHA no primeiro quadro. Media silencio e chamava de folga. Se for medir
audio de combate: mantenha o jogador VIVO, ATIRANDO e ACERTANDO.

### 6. Composicao de onda e a curva refeita

`Progressao` ganhou a tabela `COMPOSICAO` (declarativa, uma linha por onda) com
`drones`, `rotulo`, e sobrescrita de `meta`/`simultaneos`/`atiradores`/`intervalo`.
Alem da tabela, `composicaoPadrao(n)` repete o enxame a cada 5 ondas.

Onda 3 = **ENXAME** (so drone, 8 em campo, meta 10, teto de 3 atiradores). Onda 2
apresenta UM drone. A onda tematica pede a propria contagem porque drone e mais
facil de acertar e mais fragil: com a meta da curva de chao (6) a onda tematica
seria mais curta que a onda 2.

**Curva ANTES x DEPOIS** (a antiga foi calibrada quando a IA era passiva):

```
       |        meta      |    simultaneos   |   atiradores  |  reforco (s)  | drones |
 onda  |  antes    depois |  antes    depois | antes  depois | antes  depois |  novo  | rotulo
    1  |      5         3 |      6         3 |     3       2 |   7.9     6.7 |      0 | PATRULHA
    2  |      7         5 |      7         4 |     3       2 |   7.3     6.2 |      1 | BATEDOR
    3  |      8        10 |      8         8 |     3       3 |   6.7     3.2 |      8 | ENXAME
    4  |     10         8 |      9         6 |     3       3 |   6.1     5.1 |      1 |
    5  |     12         9 |      9         7 |     4       3 |   5.5     4.6 |      2 | CERCO
    6  |     13        11 |     10         8 |     4       3 |   4.9     4.1 |      2 |
    7  |     15        12 |     11         9 |     4       4 |   4.3     3.6 |      3 |
    8  |     16        16 |     12        11 |     4       4 |   3.7     2.8 |     11 | ENXAME CERRADO
    9  |     18        15 |     12        11 |     4       4 |   3.1     3.0 |      2 |
   10  |     20        17 |     12        12 |     4       4 |   3.0     3.0 |      2 |
```

Onda 1 saiu de 6 vivos / 3 atirando para **3 vivos / 2 atirando**, e o teto de 12
simultaneos que chegava na onda 8 agora chega na 10. O intervalo de reforco
encurtou NO COMECO de proposito (com o campo mais magro, esperar 8 s por dois
hostis e tempo morto) e as ondas altas ficaram onde estavam. O perfil de IA
esticou: ondas 1-5 vao de facil a normal (era 1-4), 6-13 de normal a dificil.

### 7. DEFEITO PRE-EXISTENTE ACHADO — o hostil de chao renderiza DE COSTAS

Nao corrigido, e e o item mais importante para a proxima passada de AI.

As duas convencoes do projeto nao batem:
- **Logica**: `Perception` recebe `_frente = (sin(yaw), 0, cos(yaw))` = **+Z
  local**. `_apontar` e `spawnPerto` escrevem `yaw = atan2(alvo.x - pos.x,
  alvo.z - pos.z)` — o comentario do `spawnPerto` diz "vira de frente para o
  jogador".
- **Malha**: o `Soldier` e autorado com a cara em **-Z** — nucleo aceso do peito
  em `z = -0,150`, barra de sinal das COSTAS em `z = +0,186`.

Resultado: quando a IA vira para olhar alguem, ela mostra as costas.

Provado em `tools/frente.mjs`, por marco anatomico (nao por eixo): com o yaw de
"virar de frente", a fenda optica fica a **5,95 m** da camera e a barra dorsal a
**5,69 m** — as costas estao mais perto. Com `yaw + PI`, inverte (5,00 x 5,31).
A foto `shots/drone/frente-soldado-x-drone.png` mostra os dois lado a lado.

**O drone ja sai certo** (`OFFSET_MALHA = Math.PI` em `Drone.js`). O soldado NAO
foi corrigido de proposito: somar PI onde `soldado.grupo.rotation.y` e escrito
inverte tambem o sentido do ciclo de caminhada e a IK de mira, e isso precisa de
revalidacao propria — nao cabia nesta tarefa. **Corrija com foto, nao so com
numero.**

### 8. Outro defeito pre-existente medido, e um corrigido

- **`weapon:hit` toca impacto DUAS vezes.** `AudioEngine._assina` tem
  `bus.on('weapon:hit', ...)` e `FXManager._aoAcertar` (assinante do MESMO
  evento) chama `ctx.audio.impacto()` de novo. Medido: 197 eventos -> **394**
  chamadas. E a maior categoria de voz do jogo (prio 56), dobrada, em TODO tiro —
  nao so em drone. Fica para o dono do FX decidir de que lado remover.
- **`AIManager.damageEnemy` nao entendia a chamada do PLAYER.**
  `WeaponSystem._damageEnemy` sempre chamou `ai.damageEnemy(id, dmg, payload)` e
  este metodo so entendia a forma posicional. Consequencias: `parte` chegava
  `undefined`, entao `MULT_PARTE` valia **1 sempre** (a hitbox de cabeca de 2,5x
  nunca foi aplicada por esse caminho, e o `headMult` da arma tambem nao, porque
  do lado do PLAYER `headshot` e `part === 'head'` e a IA devolve `'cabeca'`); e
  `ponto` chegava o OBJETO de payload, e `subVectors(payload, camera)` produz
  **NaN**, que ia para `soldado.flinch` e `Ragdoll.impulso`. **CORRIGIDO** — o
  metodo aceita as duas formas. Efeito colateral assumido: tiro na cabeca em
  hostil de chao passou a valer 2,5x de verdade (4 tiros -> 2 com o fuzil). Se
  isso desequilibrar, o lugar de ajustar e `MULT_PARTE`, nao o parser.

### 9. O que os outros modulos precisam saber

- **`ai.pool` continua sendo a lista UNIFICADA** (chao + drones), de proposito:
  `Progressao` escreve o perfil de dificuldade iterando ela e nao precisa saber
  que ha dois tipos. Quem precisa separar usa `ai.poolSolo` / `ai.poolDrone`.
- **Contrato novo comum aos dois tipos**: `objeto3d`, `posOlho(out)`,
  `ocupaVagaDeFogo`, `vidaDoCorpo`, `eDrone`. `Enemy.alive` continua igual.
- **`ai.spawn` e `ai.spawnOnda` ganharam um argumento `tipo`** (`'solo'` |
  `'drone'`), opcional; chamadas antigas seguem validas. **`ai.maxDrones`** e
  publico e a `Progressao` escreve nele por onda. **`ai.contarDrones()`** e novo.
- **Carcaca de drone some em 14 s** (contra 26 s do corpo de chao).
- **`enemy:damaged` / `enemy:killed` de drone levam `eDrone: true`.** Quem tratar
  esses eventos e quiser distinguir maquina que voa de hostil a pe, use isso.
- **`enemy:killed` de drone traz `point` NO CHAO**, nao onde a bala pegou:
  `Pickups._assentarNoChao` desce o item por so 4 m, e um drone abatido a 4,5 m
  deixaria a municao boiando no ar.
- **UI**: o mapa do TAB **enxerga drone** — o cone dele e horizontal, sem limite
  vertical, e o raio para `p.y + 1.1` nao atrapalha (medido livre nos tres casos
  com visada). Confirmado em foto: `shots/drone/03-drone-tab.png`.

### 10. Ferramentas novas

- `tools/drone.mjs` — sanidade de voo (altitude, folga, travamento), TTK com
  jogador sintetico de mira humana, e ciclo/teto de fogo com enxame.
- `tools/enxame.mjs` — FPS com o laco de rAF de verdade, descarte de voz, e as
  tres capturas (`shots/drone/`).
- `tools/audioenxame.mjs` — audio de combate DENTRO do jogo, com enxame e jogador
  atirando e acertando. Conta CHAMADAS POR EVENTO, que e o que pega som
  duplicado. Sem `--autoplay-policy`, sem OfflineAudioContext.
- `tools/curva.mjs` — a curva de ondas antes x depois, lado a lado.
- `tools/frente.mjs` — para que lado a malha olha (secao 7).

**Armadilhas destas, ja pagas:** jogador morto envenena tudo (secao 5); pausar
fecha o mapa do TAB e `Input.endFrame()` limpa as teclas todo quadro, entao para
fotografar o mapao e preciso ficar em `'jogando'` E neutralizar `endFrame`;
`window.__game.settle()` nao impede o rAF de mexer na cena entre o `evaluate` e o
`screenshot` (pause antes de compor); e as helices sao alimentadas dentro de
`AIManager.update`, entao captura com o jogo pausado sai sem pa nenhuma se o lote
nao for preenchido a mao.

### 11. O que continua aquem

- **O corpo do drone quase nao tem detalhe de superficie.** A silhueta e legivel
  e a fenda ciano le a 3 m, mas o casco e uma massa escura: sem costura de placa,
  sem sujeira dirigida, sem desgaste em quina. Um frame de CoD mostraria linha de
  painel e um risco especular na crista.
- **A fenda nao floresce.** Com emissivo 3,0 e limiar de bloom em 1,05 ela
  deveria ter um halo curto; sai chapada, com cara de decalque.
- **Sem sombra de contato visivel** sob o drone pairando.
- **1 a 2 amostras em 900 ainda penetram geometria** (0,1-0,2%).
- **O enxame nao "respira" como grupo**: cada drone decide sozinho. Um enxame de
  verdade tem formacao, revezamento e reacao coletiva a baixa.
- **Sem drone de tipo diferente** (kamikaze, sensor puro, pesado). O tema da onda
  3 se sustenta na quantidade, nao na variedade.

---

## [WORLD/PLAYER] O buraco no chao que nao existia, e a muralha rente a borda

**O buraco no piso era do INSTRUMENTO.** `tools/borda.mjs` relatava, andando
para o sul, `menorY = -40,2 m` — quase 37 m abaixo da cota minima do terreno
(-3,4 m), com `Player._checarQueda` resgatando o jogador. Varri o mapa inteiro
atras da face que faltava. Nao falta nenhuma.

### 1. A causa, com numero

`borda.mjs` largava o jogador numa cota FIXA: `favela.cotaMin + 30` = **26,6 m**.
O morro tem 39 m de desnivel, e na borda sul, em (0, -78), o terreno esta em
**32,4 m**. O jogador nascia **5,8 m DENTRO da encosta**.

Debaixo do terreno nao ha o que segure ninguem:

- a **"saia" das bordas** (`World._saiaTerreno`) e malha VISUAL e nunca entrou
  no BVH — existe so para nao se enxergar o vazio de longe;
- `_depenetrate` so empurra quem PENETRA um triangulo, e quem esta 6 m abaixo
  da superficie nao encosta em nada;
- `_sondaChao` atira os 5 raios de cima para baixo, e de dentro do morro todos
  saem pela parte de baixo do terreno sem bater em nada.

Queda livre ate o teto de 55 m/s, `y < -40`, resgate. De dentro do jogo isso le
exatamente como "atravessei o chao".

### 2. O mapa NAO tem buraco — medido celula por celula

`tools/piso.mjs` (novo) varre as **85 258 celulas andaveis** do `navGrid`
(0,5 m) com quatro medicoes independentes:

| medicao | o que testa | resultado |
|---|---|---|
| COLUNA | raio de cima para baixo: ha QUALQUER triangulo embaixo? | **0 colunas vazias** |
| DE PE | a capsula (0,35 x 1,80 m) termina `grounded` ali? | 299 avisos, nenhum e queda |
| TUNEL | queda a 55 m/s com o pior `dt` do jogo (0,05 s) | **0 de 1 765 atravessaram** |
| RASTRO | 25 s andando contra cada borda, com largada correta | **0 mergulhos nas 4** |

Nenhuma das quatro suspeitas classicas se confirmou: nao ha face faltando no
terreno, nao ha quina aberta entre terreno e laje, `capsuleSweep` nao tunela em
velocidade terminal e nao ha normal invertida de casa ou de escada.

Colisao do terreno x plano do terreno, nas celulas andaveis: **69 355 dentro de
+-0,25 m**, 3 363 entre 0,25 e 0,75 m acima, 691 entre 0,25 e 0,75 m abaixo, e
so **5 celulas** mais de 0,75 m abaixo. A colisao do terreno e decimada (1
triangulo a cada 2 m contra 1 m da malha visual) e e dai que vem essa dispersao.

### 3. Tres armadilhas de medicao que a propria ferramenta pagou

**(a) Sonda de chao largada PERTO do chao mente.** A primeira versao do
`piso.mjs` largava o raio em `plano + 0,60 m` e acusou **44 celulas sem piso**
(40 "vazio", 3 "fundo", 1 normal ruim) — entre elas (51,5, -36,8), (67,1, -4,9),
(-18,8, -3,3), (17,3, 38,8). Nenhuma existe: onde a colisao decimada sobe acima
do plano, o raio nascia DENTRO do morro apontando para baixo e nao batia em
nada. Sonda de chao se larga de CIMA.

**(b) Sonda largada ALTA DEMAIS acha a muralha.** Trocando o teto para
`cotaMax + 60`, o raio passou a bater na TAMPA da muralha invisivel (que vai ate
`cotaMax + 30` e atravessa o mapa de ponta a ponta): **6 182 celulas** viraram
"piso a 65,72 m". O teto da sonda agora sai de `world.muralha.topo`.

**(c) O vetor de movimento e relativo ao YAW, e ninguem escrevia o yaw.**
`Movement` monta a frente com `_fwd = (-sin yaw, 0, -cos yaw)` a partir de
`cmd.yaw`, que vem do `CameraRig`. `borda.mjs` sobrescrevia `getMoveVector` mas
deixava o yaw como `Player.init()` tinha sorteado — os quatro "rumos cardeais"
andavam todos para o lado errado. **Quem dirigir o jogador por codigo escreve
`jog.rig.reset(Math.atan2(-dx, -dz), 0)` ANTES de mexer no vetor de movimento.**
A mesma conta vale para apontar a CAMERA de captura: escrito a mao, leste e
oeste saem trocados e a foto olha para dentro do mapa.

### 4. O que mudou no jogo, e nao so nas ferramentas

**`Movement.teleport` ganhou guarda contra pouso dentro do morro.** Destino
abaixo de `world.heightAt(x, z) - 0,5` sobe para a cota do chao e avisa no
console. A referencia e o PLANO do terreno, nao um raio de cima para baixo: raio
devolveria o TELHADO de quem esta dentro de casa, e teleporte para o interior
passaria a jogar o jogador em cima dela. Piso de construcao esta sempre na cota
do terreno ou acima, entao a guarda so pega quem ficou realmente enterrado.
Isso mata a classe inteira do defeito, venha ela de ferramenta, de `respawn()`
ou de `_checarQueda`.

**`Player._checarQueda` continua igual e continua sendo a ultima rede.** Com a
largada corrigida, ela nao dispara mais em nenhuma das quatro bordas.

### 5. A muralha da borda, apertada com medida

`MARGEM_BORDA` era **2,5 m medida ate o EIXO da caixa**, e a caixa tem 2 m de
espessura: a conta que o jogador sentia era `2,5 + 1 = 3,5 m` de terreno
inalcancavel em todo o perimetro. A quina do mapa — que e boa justamente para
correr e escapar — nao existia para ele.

Agora `MARGEM_BORDA` e medida ate a **face interna**, que e onde o corpo para, e
vale **0,6 m**. O raio da capsula e 0,35 m, entao o corpo inteiro fica sobre
terreno com folga.

| | antes | depois |
|---|---|---|
| face interna | +-86,5 m | **+-89,4 m** |
| eixo da capsula chega a | +-86,15 m | **+-89,05 m** |
| terreno alem do corpo | 3,5 m | **0,6 m** |
| area jogavel | 173,0 x 173,0 m (92,3%) | **178,8 x 178,8 m (98,7%)** |

Medido em `tools/muralha.mjs`, indo contra as quatro bordas **andando,
agachado e deslizando** (12 tentativas de 16 s): todas encostaram, **0 quadros
fora dos limites, 0 quedas**, corpo parando sempre a 0,60 m da aresta, com pico
de 8,4 m/s no deslize e 70-73 quadros deslizando por borda. A ferramenta procura
na malha uma faixa de 13 m livre ate a parede antes de largar o boneco — sem
isso ele empaca numa casa e o teste passa sem que ninguem tenha chegado la
(aconteceu: tres dos quatro rumos paravam a 15 m da barreira).

**A camera nao ve rasgo nenhum, e a troca e outra do que se supunha.**
Encostado na parede e olhando para fora, o chao so aparece entre **-41 e -67
graus** abaixo do horizonte (e o que aparece e a SAIA do terreno, nao o terreno)
e dali para baixo nunca volta a ficar vazio — nao ha buraco entre o chao e o
horizonte em nenhuma das quatro bordas, de pe ou agachado.

O que muda com a margem apertada nao e ver ou nao ver o vazio; e QUANTO da tela
ele ocupa. A 3,5 m a aresta entrava no quadro a ~24 graus e sobrava uma faixa de
chao alem do corpo; a 0,6 m ela so entra a ~60 graus, e entre o horizonte e isso
o que se ve e **nevoa de distancia** — a mesma que se ve de qualquer ponto alto
do morro, porque fora dos 180 m nao existe mundo nenhum modelado. Nao le como
defeito, mas le como fim de arena. Se um dia incomodar, o lugar de resolver e
cenario de fundo alem da borda, nao a espessura da barreira. Capturas em `shots/borda/`:
`*-olhando.png` (pitch -12, a vista de jogo) e `*-aresta.png` (pitch -50, cabeca
baixa). Em nenhuma delas ha rasgo: abaixo do horizonte o que aparece e a nevoa
de distancia, nao buraco preto.

**`world.muralha` e publico** (`meia`, `faceInterna`, `base`, `topo`,
`espessura`, `margem`). Quem medir borda usa isso em vez de refazer a conta e
errar meia espessura.

**O `navGrid` agora zera a faixa atras da muralha** (passo 4b). Antes a malha
saia do PLANO, que nao sabe da barreira, e a IA planejava caminho para uma faixa
que a colisao proibe. Celulas andaveis: 88 007 -> 85 258.

### 6. Ferramentas

- `tools/piso.mjs` (novo) — as quatro medicoes da secao 2, com `--json` para
  comparar antes e depois. So `vazio` e `afundado` reprovam; `saliente` e
  `semapoio` sao informativos (telhado, beiral, caixa d'agua, veiculo ou tronco
  em cima de celula andavel — a malha sai do plano e nao conhece nada disso).
- `tools/muralha.mjs` (novo) — geometria da barreira, os 12 encostroes, o
  angulo em que a aresta aparece e as quatro capturas. `SO_FOTO=1` refaz so as
  fotos.
- `tools/borda.mjs` — corrigido (largada sobre o chao daquele ponto, yaw
  escrito) e com duas verificacoes novas: a largada tem de ser no ar e o corpo
  tem de terminar sobre o terreno.

### 7. O que continua aquem

- **A colisao do terreno e 2 m; a malha visual e 1 m.** Em 5 celulas o piso de
  colisao fica mais de 0,75 m ABAIXO do que se ve, e em 3 363 de 0,25 a 0,75 m
  ACIMA. Ninguem cai por isso, mas o pe afunda ou flutua um pouco em quina de
  plataforma achatada. Casar as duas resolucoes custa 4x os triangulos de
  terreno (16 200 -> 64 800, de um total de 94 360) e nao foi medido em fps.
- **299 celulas andaveis onde a capsula nao fica `grounded`** no topo da coluna
  — telhado estreito de prop, capo de carro, barranco decimado mais ingreme que
  o plano. Nao e queda para fora do mundo (ha chao logo abaixo), mas e
  desacordo entre malha e colisao, e a IA pode planejar por ali.
- **`tools/borda.mjs` no rumo sul para a 4,36 m da aresta**, barrado por
  geometria antes de encostar na muralha. O teste passa, mas naquela borda ele
  nao esta exercitando a barreira — quem exercita e o `muralha.mjs`, que
  escolhe a faixa livre.

---

## [CORE] O travamento intermitente: era compilacao de shader na entrada do inimigo

O relato foi "pico de CPU, GPU tranquila, principalmente quando a tela enche de
player e surgem drones". Medido quadro a quadro, e exatamente isso — e a causa
tem nome, numero e um so lugar.

### 0. O instrumento vem primeiro: `tools/pico.mjs`

Travamento intermitente nao se acha lendo codigo. `tools/pico.mjs` grava, para
CADA quadro de uma partida de verdade (piloto automatico que anda, mira nos
hostis, atira, recarrega, abre porta e troca de arma):

`dt do rAF` · `renderer.info.programs.length` · heap JS · draw calls ·
triangulos · o tempo de **cada** sistema do laco (com os suspeitos aninhados
nomeados: `_regenerateEnvironment`, `refreshMaterials`, `_renderEnv`,
`_updateCascades`) · os eventos daquele quadro · onda e censo de hostis.

Com isso as tres assinaturas de travada se separam sozinhas, e o relatorio
testa as tres explicitamente:

| assinatura | como se prova | veredito medido |
|---|---|---|
| PERIODICO | picos alinhados com um periodo do codigo | **descartado** |
| COMPILACAO | pico coincide com `programs.length` subindo | **e esta** |
| COLETA DE LIXO | pico coincide com o heap CAINDO | **descartado** |

O roteiro e a parte que responde a pergunta certa: cada familia de inimigo
entra em cena **duas vezes**, com o campo limpo entre uma e outra
(`1a-onda-chao` · `2a-leva-chao` · `1o-enxame-drone` · `2o-enxame-drone` ·
`chao+drone-juntos`). Pico so na primeira = compilacao. Pico nas duas = spawn.

### 1. Causa raiz medida

No three.js o programa de um material so e compilado quando aquela COMBINACAO
entra pela primeira vez no funil de render. Hostil e drone ficam
`visible = false` no pool ate nascer, entao **nada deles foi compilado enquanto
nao aparece o primeiro**. No quadro em que a leva entra, o ANGLE traduz e
compila tudo de uma vez, na thread principal.

Partida de 179 s, 1280x720, preset alto, GTX 1060 (D3D11):

```
p50 16,70 ms · p90 19,30 · p99 24,40 · p99.9 36,70 · PIOR 1554,10 ms
```

Os DOIS unicos quadros catastroficos da corrida inteira sao os dois em que
`programs.length` subiu:

| quadro | ms | programas novos | quais |
|---|---|---|---|
| 1a entrada de hostil de chao | **1554,10** | 3 | `depth` com skinning (material de sombra) + 2x `ai_soldado` |
| 1a entrada do enxame de drone | **655,30** | 1 | `ai_drone` |

E o teste de "primeira vez x toda vez" fecha o caso — mesma corrida, mesmo
instrumento, campo limpo entre as levas:

| trecho | p50 | p99 | PIOR | programas novos |
|---|---|---|---|---|
| 1a-onda-chao | 16,70 | 24,90 | **1554,10** | 3 |
| 2a-leva-chao | 16,70 | 21,50 | 36,70 | 0 |
| 1o-enxame-drone | 16,70 | 22,60 | **655,30** | 1 |
| 2o-enxame-drone | 16,70 | 21,50 | 26,80 | 0 |
| chao+drone-juntos | 16,80 | 28,00 | 38,50 | 0 |

Repetido em 4 corridas sem aquecimento: o pior quadro da 1a onda de chao deu
1554 / 1933 / 3416 / 3473 ms, **sempre** com os mesmos 3 programas; o do 1o
enxame deu 655 / 727 / 731 / 1179 ms, sempre com 1. A segunda entrada nunca
passou de 46 ms. Nao ha ambiguidade.

**As outras duas hipoteses foram medidas e descartadas na mesma corrida:**
- `Sky._envInterval = 96` -> `Lighting._regenerateEnvironment` (PMREM novo a
  cada 96 quadros, com `dispose` do anterior) custa **mediana 0,00 ms, p99 0,40,
  MAXIMO 1,9 ms**. Nao e o pico. O teste de alinhamento com periodo 96 tambem
  nao acusa nada (maior classe 1 de 7 picos, acaso ~0,1).
- Coleta de lixo: apenas 2 dos 7 picos coincidem com queda de heap, e nenhum
  dos dois quadros ruins.

### 2. A correcao — `src/core/Aquecimento.js` (novo)

`aquecerCena(ctx)`: expoe tudo que esta invisivel (hostil, drone, lote de
helices, item, arma guardada) com `frustumCulled = false`, e desenha **dois
quadros de verdade** com o pipeline real. Antes disso, um passe
`compileAsync` paralelo com o alvo e o tonemap corretos.

**Tres detalhes sem os quais o aquecimento nao funciona** (todos verificaveis
na chave de cache do programa):

1. **`renderer.compile()` NAO cobre o material de profundidade da sombra.** Um
   dos tres programas do quadro de 1,5 s era exatamente esse — criado pelo
   `WebGLShadowMap`, nao pelo passe principal. So um render de verdade o pega.
2. **A chave de cache inclui `toneMapping` e `outputColorSpace`, e os dois
   dependem do ALVO.** Com PostFX ligado o `Engine` poe `NoToneMapping` e
   desenha o mundo num alvo HDR linear; compilar contra a tela (sRGB + ACES)
   gera programa com outra chave, que o jogo nunca usa. Por isso o aquecimento
   tem de rodar **no fim do boot**, depois de o `PostFX` existir.
3. **`ctx.lighting.refreshMaterials()` ANTES de compilar.** Sem os defines
   `USE_CSM`/`CSM_CASCADES`/`OCA_PCSS` no material, a variante compilada nao e
   a que o jogo usa e ela seria recompilada no primeiro quadro de jogo.

`?semaquecer=1` na URL desliga tudo. Existe so para o lado "antes" do A/B do
`pico.mjs` — nao use em outra coisa.

### 3. Antes x depois

| | sem aquecimento | com aquecimento |
|---|---|---|
| programas compilados DURANTE a partida | **4** (em 4 de 4 corridas) | **0** (em 4 de 4 corridas) |
| pior quadro na 1a entrada de hostil de chao | 1554 · 1933 · 3416 · 3473 ms | 29 · 62 · 138 · 282 ms |
| pior quadro na 1a entrada do enxame | 655 · 727 · 731 · 1179 ms | 49 · 208 · 432 · 472 ms |
| p50 / p99 (corrida mais limpa, 180 s) | 16,70 / 24,40 ms | 17,00 / 38,10 ms |
| boot | 22,2 s | 28,8 s (aquecimento 10,4 s) |

O custo e o boot: **+6,6 s de barra de carregamento**. Nao e trabalho novo — e
o MESMO trabalho, movido para onde ninguem sente. Sem aquecimento os 40
programas do mundo compilavam nos primeiros quadros depois de `boot:done`
(engasgo na entrada do menu) e os 4 do inimigo no primeiro combate.

O passe `compileAsync` paralelo vale 4 s desses 10,4 (era 14,5 s so com render
de verdade). Ele resolve 24 dos 44 programas; os outros 20 saem dos dois
quadros reais em 1,2 s.

### 4. O que os outros modulos precisam saber

- **`ctx.debug.aquecimento`** e o relatorio do aquecimento
  (`{ms, msParalelo, programasAntes, programasDepois, expostos, paralelo}`).
- **Material NOVO criado depois do boot volta a engasgar.** Se algum modulo
  passar a criar material em runtime (arma nova, efeito novo, variante de
  inimigo), o programa dele compila no primeiro uso e o pico volta. O caminho
  e criar o objeto antes do fim do boot (mesmo invisivel) — o `Aquecimento`
  pega qualquer coisa que ja esteja na cena, visivel ou nao.
- **`userData.semAquecimento = true`** exclui um objeto do aquecimento. Nao ha
  nenhum hoje; e gancho para quem precisar.
- **`main.js` mudou em 9 linhas** (dono: CORE): um `import` e um bloco de duas
  linhas com `progress('Compilando shaders', 0.99)` logo antes de
  `progress('Pronto', 1.0)`. Nada mais foi tocado la.
- **FX (pedido, nao editei — o arquivo esta com outro agente):**
  `FXManager._preAquecer` chama `renderer.compileAsync(ctx.scene, ctx.camera)`
  no meio do boot, ANTES de o `PostFX` e a `AIManager` existirem. Pelos dois
  motivos da secao 2 (alvo/tonemap errados e cena sem inimigo) ele nao podia
  cobrir este defeito. A emissao de particula/decal/tracer de mentira que ele
  faz continua util (sobe atributo de instancia e textura); o bloco de
  `compile`/`compileAsync` virou redundante com o `Aquecimento`. Nao medi o
  custo isolado dele, entao nao afirmo que remove-lo economiza boot.

### 5. Ferramentas

- `tools/pico.mjs` — a ferramenta acima. `MEDIR=` segundos, `AQUECER=0` para o
  lado "antes", `TAG=` nomeia o dump (`tools/pico.<tag>.json`). Ficam gravados
  `tools/pico.antes.json` e `tools/pico.depois.json`, as duas corridas de
  referencia de 180 s.
- `tools/lixocontrole.mjs` — afericao dos medidores de alocacao (secao 7).

**Armadilhas destas, ja pagas:**
1. **Rodar `ai.update()` num laco sincrono dentro de `page.evaluate` bloqueia o
   rAF** — nao existe quadro para medir. Tudo aqui roda no laco de verdade.
2. **A coluna "fora"** do relatorio (ms do quadro que nao estao em nenhum
   sistema do jogo) e o que separa "o jogo engasgou" de "a maquina engasgou".
   Nesta bancada, com outros agentes rodando Playwright, apareceram quadros de
   2 a 3 s com **fora ~= dt** e zero trabalho do jogo dentro. Sem essa coluna
   eles seriam lidos como defeito do jogo. Os picos de compilacao, ao
   contrario, tem `fora` de 2 a 10 ms: o tempo esta TODO dentro do `render`.
3. **Comecar a gravar com o campo ja povoado nao serve**: o primeiro quadro
   medido ja e o quadro da entrada e nao ha linha de base. O roteiro grava 4 s
   de campo vazio antes de qualquer coisa.
4. Piloto automatico que so gira o YAW nao produz combate: o drone voa a
   2,4-4,2 m e o hostil pode estar num nivel acima. Sem mira em pitch o boneco
   atira no muro e a carga nunca acontece.

### 6. O que continua engasgando (medido, nao resolvido)

- **`render` p99 e 24 ms com p50 de 6,3 a 7,8 ms.** A cauda normal do quadro
  mora quase toda no `engine.render`, e ela existe com aquecimento ou sem. Nao
  investiguei: nao e travamento, e variacao de custo de desenho.
- **Um quadro de 3307 ms com `ai.update` = 3248 ms**, uma unica vez em 8
  corridas, sem programa novo e sem queda de heap. **Nao sei explicar.** Pode
  ser o processo sendo desescalonado dentro do `ai.update` (a mesma corrida tem
  dois quadros de 2,1 e 2,6 s com `fora ~= dt`, que sao claramente da maquina),
  pode ser um caso patologico de busca de rota. Quem for mexer na IA: rode
  `tools/pico.mjs` numa maquina ociosa e veja se reaparece.
- **Um quadro de 796 ms e outro de 3105 ms com o tempo TODO dentro do
  `render`, e ZERO programa novo.** Compilacao esta descartada por construcao.
  Suspeito da fila da GPU (ha outros Chrome renderizando nesta bancada) ou de
  criacao de estado de pipeline no ANGLE, que nao aparece em
  `info.programs`. Nao consegui provar nem descartar.
- **A bancada esta ruidosa e isso contamina o p99.** Nas 8 corridas o p99 do
  mesmo binario variou de 24 a 104 ms conforme a carga externa. **Compare
  sempre dentro da mesma corrida**; o numero que sobrevive ao ruido e
  "programas novos durante a partida", que deu 4 e 0 sem excecao.

### 7. AFERICAO: como NAO medir alocacao neste projeto

O relatorio do `pico.mjs` acusa ~650 KB alocados por quadro e centenas de
quedas de heap maiores que 2 MB. Antes de acusar qualquer modulo, aferi os
medidores com um alocador de tamanho CONHECIDO (`tools/lixocontrole.mjs`,
~57,2 MB em 600 quadros):

| instrumento | leu |
|---|---|
| alocado de verdade | ~57,2 MB |
| amostrador de alocacao do V8 via CDP (`HeapProfiler.startSampling`) | **0,0 MB** |
| soma das SUBIDAS de `performance.memory.usedJSHeapSize` | 27,6 MB |

1. **Nao use `HeapProfiler.startSampling` para achar quem aloca aqui.** Erra
   por mais de 1000x — nao enxerga a alocacao de vida curta, que e justamente a
   que interessa. Uma passada inteira foi gasta assim, e a ferramenta que a
   usava foi apagada em vez de ficar no repositorio mentindo.
2. A soma das subidas de `performance.memory` e um **piso** (subestimou 2x),
   nunca um teto. Se ela acusa 650 KB por quadro, e pelo menos isso.
3. Queda de heap maior que 2 MB nao deu **um unico falso positivo** no
   controle: quando o relatorio conta centenas delas, sao coletas de verdade.

Ou seja: **o jogo aloca muito** (>= 650 KB por quadro em combate, contra a
regra 6 do `ARCHITECTURE.md`) e coleta com frequencia. Isso e divida real, mas
**nao e a causa do travamento relatado**: so 2 a 11 dos picos por corrida
coincidem com queda de heap, e nenhum dos quadros catastroficos. Quem for
atras disso precisa antes de um instrumento que funcione — nenhum dos dois
acima serve para apontar a linha.

---

## [PLAYER/morte] A queda encenada, o engasgo da tela final, e o impacto que tocava duas vezes

Tres coisas numa passada: a morte virou CENA, a tela de morte parou de custar
um quadro inteiro, e o som de impacto duplicado (achado anterior, em aberto)
foi resolvido.

### 1. A morte agora tem um beat — `src/player/QuedaMorte.js` (novo)

Antes: `player:died` trocava o estado, escondia o HUD e 900 ms depois a tela
entrava. A camera nao se mexia um pixel.

Agora: **estado novo `'caindo'`** entre `'jogando'` e `'morto'`. O corpo tomba,
a vista vai ao chao em camera lenta, e so quando a queda termina e que a tela
de morte entra — por **`player:caiu`**, evento novo.

**O modelo e uma barra rigida articulada nos PES que encolhe enquanto cai.**
`alpha = (3g/2L)*sin(theta)`, com `g = 14,5` (o mesmo exagero do `Ragdoll.js`,
pela mesma razao: 9,81 ja le como camera lenta). O comprimento vai de 1,68 m a
42% disso ao longo da queda — poste cai inteiro, gente desaba, e e o
encolhimento que faz a diferenca entre as duas leituras.

A camera e rigida na ponta da barra: **um** quaternion em torno de
`cross(cima, dirQueda)`. Sem decomposicao em pitch e roll — quem cai de lado ve
o horizonte girar, quem cai para a frente ve o chao subir, e a mistura sai certa
sozinha. **A ORDEM DO PRODUTO VETORIAL IMPORTA** e eu errei nela: com
`cross(dirQueda, cima)` o topo tomba para `-dirQueda` e o jogador cai de costas,
terminando de cara para o ceu. So apareceu na foto.

**Por que NAO o `Ragdoll.js`** (foi avaliado, esta escrito no cabecalho do
arquivo): ele escreve **quaternion de OSSO** de um `Soldier`, e o jogador nao
tem malha nem esqueleto — usa-lo exigiria fabricar um esqueleto falso para ler
uma particula e jogar quatorze fora; ragdoll em primeira pessoa le como bug de
fisica, nao como drama; e `Ragdoll._colidir` **so conhece o chao**, entao a
parte dificil (nao terminar dentro de parede) teria de ser escrita do zero de
qualquer jeito. O que foi reaproveitado dele: a gravidade exagerada, o cache de
altura de chao por celula e o saneamento de valor nao-finito.

### 2. Camera lenta: `ctx.time.scale` (contrato NOVO do CORE)

`main.js` multiplica o dt de TODOS os sistemas por `ctx.time.scale` antes de
repassar. Quem encena escreve nela; hoje so a `QuedaMorte`.

- **`ctx.time.dtReal` e o dt de PAREDE do mesmo quadro.** Quem conta tempo de
  relogio (duracao de encenacao, espera de UI) LE DALI. Contar com `dt` faz a
  camera lenta esticar tambem a espera do jogador.
- **Quem liga a escala tem de desliga-la em TODOS os caminhos de saida.**
  `respawn()` e `destravar()` chamam `queda.cancelar()`; o botao "Abandonar" do
  menu tambem. Escala presa em 0,42 e o pior defeito possivel aqui — o jogo
  inteiro passa a rodar a 42% e ninguem liga a causa a tela de morte.
- Valores medidos: escala **0,42**, queda inteira **1,34 s de parede**. Sem
  escala a queda dura 0,56 s e o jogador nao registra que caiu.

### 3. A trava de 5 s da tela de morte NAO foi tocada

`Menu._travarMorte` continua sendo a unica dona da espera, disparada por
`mostrar('morte')`. O que mudou foi **quando a tela entra**: era um prazo cego
de 900 ms, agora e o fim da queda. O `Menu` parou de escrever
`ctx.state = 'morto'` no `player:died` — era isso que congelava o
`Player.update` no primeiro quadro e impedia qualquer encenacao. Ha uma rede de
seguranca de 2,6 s caso `player:caiu` nunca chegue (aba em segundo plano,
excecao no meio da queda).

Primeiro clique do jogador: **~6,3 s** (1,3 de queda + 5 de trava), contra 5,9 s
antes.

### 4. O ENGASGO — medido, e nao era nenhum dos suspeitos

`tools/telafinal.mjs` (novo). Mede o periodo REAL do `requestAnimationFrame`
com o laco do jogo rodando por baixo — nao `engine.render()` em rajada, porque
o custo de um overlay de DOM e de COMPOSICAO do navegador e so aparece num
quadro de verdade. Reporta mediana, **p95 e maximo**: "travar" e PICO de quadro,
e um quadro de 90 ms no meio de sessenta de 11 ms some na media.

**Os dois suspeitos apontados foram DESCARTADOS por medicao:**

- **`feTurbulence` do `fundo-grao`**: delta de -0,1 a +1,7 ms entre quatro
  execucoes, com o SINAL TROCANDO. Esta abaixo do piso de ruido. E, decisivo:
  **ele nem existe na tela de morte** — `${fundo}` so entra em `tela-carga` e
  `tela-menu`, e telas inativas ficam em `visibility: hidden`.
- **`.sangria`**: delta 0,00 ms em duas execucoes. E um gradiente estatico; o
  navegador pinta a camada uma vez.

**A causa real:** com o jogador morto a cena esta congelada — ninguem anda, a
IA nao roda, a camera nao mexe — e o jogo continuava **redesenhando 5,9 M de
triangulos e ~750 draw calls 60 vezes por segundo para produzir o MESMO
quadro**. Medido: o render valia 8,9 a 13,4 ms de um quadro de 9,7 a 14,1 ms;
TODO o resto junto (overlay de DOM, audio, mundo, HUD, pos-processamento) valia
**0,7 ms**.

Correcao em `main.js`, duas linhas de efeito:
- `PASSO_MORTO = 4` — em `'morto'`, redesenha a cada 4 quadros (~15 Hz).
  Congelar de vez foi descartado: em driver que nao preserva o buffer de
  desenho o canvas pode piscar preto.
- `Sky.update` e `Lighting.update` **nao rodam em `'morto'`**. O `Sky` regenera
  o mapa de ambiente (um PMREM inteiro) a cada 96 quadros — um pico a cada
  1,6 s numa tela em que nada muda.

**Resultado, A/B na MESMA execucao** (cenario `morte-como-antes` = mesma
marcacao, mesmo CSS, mesma cena, redesenhando todo quadro):

| | antes | depois | ganho |
|---|---|---|---|
| campo vazio, mediana | 8,4 – 19,1 ms | 0,5 – 0,8 ms | 7,7 – 18,3 ms |
| campo vazio, p95 | 13,7 – 29,0 ms | 6,9 – 15,9 ms | 5,3 – 13,1 ms |
| em combate (onda 1), mediana | 11,4 – 19,0 ms | 0,6 – 0,9 ms | 10,8 – 18,2 ms |
| em combate, p95 | 16,0 – 38,0 ms | 10,9 – 17,0 ms | 5,1 – 21,0 ms |

Faixas porque sao quatro execucoes. **Nao compare estes numeros com os de outra
execucao**: entre a primeira e a segunda medicao outro agente somou
pre-aquecimento de shader ao boot e o lado `jogando` mudou junto. So o par A/B
dentro da mesma execucao vale.

### 5. `weapon:hit` tocava impacto DUAS vezes — RESOLVIDO

O achado da secao 8 de [AI]/drone estava em aberto. **O dono agora e o AUDIO.**
A linha `this.ctx.audio?.impacto?.(...)` saiu de `FXManager._aoAcertar`;
`AudioEngine._assina` ja assinava `weapon:hit` desde sempre.

Por que o AUDIO e nao o FX: ele assina o evento direto do barramento (nao
depende de o FX estar vivo nem de a qualidade ter cortado particula), e som e o
modulo dele. O FX ali cuida do que e visivel — particula, decal, clarao.

Conferido em `tools/audioenxame.mjs`: `weapon:hit 148 -> A.impacto 148`, **1:1**
(era 197 -> 394). Descarte 0%, deriva do relogio de audio 4 ms em 12 s (0,04%).

### 6. O que os outros modulos precisam saber

- **`ctx.state` tem um valor novo: `'caindo'`.** Quem testa `!== 'jogando'`
  continua correto. Quem testa `=== 'morto'` para saber se o jogador morreu
  **agora perde a janela da queda** — use `ctx.player.alive === false`.
- **`ctx.time.scale`** (novo) e **`ctx.time.dtReal`** (novo). Ver secao 2.
- **`player:caiu`** (novo, PLAYER -> UI): `{ duracao:number, posicao:Vec3 }`.
  Sai quando a encenacao termina, imediatamente antes de `ctx.state` virar
  `'morto'`. E o gatilho da tela final.
- **`Player._die(fromDir)`** ganhou um argumento (a direcao do tiro que matou,
  usada como desempate do lado da queda). Chamadas sem argumento seguem validas.
- **`ctx.player.queda`** e publico: `.ativa`, `.iniciar(dir)`, `.cancelar()`,
  `.determinista` (para ferramenta de captura: tira o sorteio, duas mortes saem
  iguais).
- **`ViewModel.quedaT`** (0..1, escrito pela `QuedaMorte`): a arma afunda, rola
  e some. Camada ADITIVA no fim de `update()`, depois da composicao final — a
  pose de quadril/ADS/corrida segue sendo calculada normal. A luneta continua
  mandando: `root.visible` e o E logico das duas condicoes.
- **`player:land` e emitido no baque do corpo** (`velocity: 6.5`, superficie
  medida por raycast). Reuso deliberado: o AUDIO ja tem a batida por superficie,
  o FX ja levanta poeira no ponto e o Player ja converte em dip de camera.
- **Em `'caindo'` so `ctx.player` e `ctx.fx` atualizam** (alem dos
  `pausable === false` de sempre). IA, `Progressao` e `Pickups` ficam parados.
- **Em `'morto'` o render e a 15 Hz e ceu/iluminacao nao rodam.** Se alguem
  precisar de animacao viva na tela de morte, e aqui que se mexe.

### 7. Prova de que a camera nao termina dentro de geometria

`tools/queda.mjs`, 40 quedas: 20 pontos de spawn, cada um **no aberto e
ENCOSTADO na parede** (o boneco e empurrado ate 0,45 m da parede mais proxima e
virado de cara para ela — morrer no meio da rua nao prova nada).

**40/40 livres. Folga minima ate a geometria mais proxima: 0,341 m** em todos os
casos, que e exatamente o raio de seguranca. 40/40 acima de 0,15 m do piso.

Tres defesas, em ordem de importancia:
1. **`_avancar`** — o olho parte do EIXO DA CAPSULA do jogador, o unico ponto do
   mundo que se sabe livre de graca (o `Movement` mantem a capsula fora de
   geometria todo quadro), e caminha dali com um `sphereCast` que para no
   primeiro contato. **Nunca entra**, em vez de entrar e ser resgatado.
2. Piso por raycast vertical com cache por celula.
3. Depenetracao por esfera (`sphereCast` com `maxDist = 0`), a mesma do drone.

A versao sem o item 1 — so depenetracao — **falhou em 1 de 40**, com a camera a
0,011 m de uma face: a depenetracao nao acha superficie quando o ponto ja esta
mais fundo que o raio de busca.

### 8. Ferramentas novas, e as armadilhas que elas pagaram

`tools/queda.mjs` — cronometro da encenacao, sequencia de capturas, auditoria de
geometria em 40 quedas, e a volta (morrer, reiniciar, morrer de novo).
`tools/telafinal.mjs` — ms/quadro nas telas finais, com A/B de cada suspeito.

**Nao repita:**

1. **`page.screenshot()` leva 200-600 ms e isso NAO entra em
   `waitForTimeout(marco - anterior)`.** A primeira sequencia matava uma vez e
   tirava nove fotos seguidas; o quadro rotulado "t=180 ms" era o de ~1 s, com o
   corpo ja no chao. A sequencia inteira mentia sobre o proprio eixo do tempo.
   Agora e **uma morte por captura**, com `queda.determinista = true`.
2. **"Ha superficie a menos de R" NAO e o criterio de penetracao.** A primeira
   auditoria usou `sphereCast(p, dir, 0.30, 0)` e reprovou 6 de 6 — todos com a
   superficie a 0,30 m exatos. Era o instrumento medindo a propria correcao: a
   depenetracao POE o olho a `RAIO_OLHO` da geometria, entao aquilo e verdade
   por construcao. O criterio certo e a ENVOLTURA — leque de 26 direcoes,
   contando quantas batem perto. Dentro de um solido, todas batem.
3. **Sonda de altura de chao: `groundAt` NAO serve, e `olho + 2,0 m` tambem
   nao.** O primeiro sai de y=200 e acerta o telhado (medido: -59,8 m num ponto
   valido); o segundo acerta a laje que passa a menos de 2 m sobre a cabeca
   (medido: -1,37 m). Saia de `olho + 0,10 m`. Mesma armadilha ja registrada
   para a altitude do drone.
4. **A trava de 5 s tem de ser conferida COLADA no fim da queda.** Conferida
   depois da sequencia de fotos ela ja expirou sozinha, e o teste reprova uma
   coisa que funciona.
5. **`ai.spawnOnda()` na mao com a `Progressao` desligada nao povoa o campo.**
   O censo terminava com 0 vivos e 735 draw calls — os mesmos do campo vazio.
   Deixe a `Progressao` povoar; neutralize so o dano no jogador (`_die()` tira o
   estado de 'jogando' e a IA inteira cai em patrulha — armadilha ja
   registrada).
6. **`display: none` no overlay muda o ritmo do rAF do navegador** (mediu
   17,3 ms estaveis, pior que com o overlay). Nao serve para isolar custo de DOM.

### 9. O que continua aquem

- **A queda nao tem NADA de vermelho.** O HUD e escondido no primeiro quadro
  (comportamento antigo, preservado) e o veu de sangue so chega com a tela. Um
  esmaecimento de `.sangria` entrando nos ultimos 40% da queda seria o passo
  obvio, e mexe em CSS de UI e na interacao com `_travarMorte`.
- **O chao a 0,52 m sai borrado** no quadro final — textura em angulo rasante
  sem anisotropia, nao desfoque de profundidade. Nao da para consertar daqui.
- **A queda nao reage ao TIPO de morte**: cair de granada, de queda ou de rajada
  a queima-roupa produz exatamente a mesma tombada.
- **`ctx.time.scale` nao afeta o audio.** O tiro que matou continua decaindo em
  tempo normal enquanto a imagem esta a 42%. Um `playbackRate` na cauda daria o
  efeito completo de camera lenta.
