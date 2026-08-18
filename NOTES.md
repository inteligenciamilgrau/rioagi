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
