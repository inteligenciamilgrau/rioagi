# Operação RIO-AGI

FPS em primeira pessoa feito em [Three.js](https://threejs.org), ambientado numa
favela carioca. Mundo, texturas, sons e personagens são **gerados por código** —
não há arquivo de modelo 3D nem de textura no repositório.

> Construíram a AGI com a inteligência da humanidade e a apontaram para o mundo.
> Onze dias e estava tudo sob controle — menos o morro.

A história completa está em [HISTORIA.md](HISTORIA.md).

---

## Rodar

Precisa de [Node.js](https://nodejs.org) 18 ou mais novo.

```bash
npm install
npm run dev
```

Abre em <http://127.0.0.1:5173>.

No Windows, `RODAR.bat` faz isso sozinho: procura o Node em alguns caminhos
conhecidos, instala as dependências na primeira vez e abre o navegador.

## Controles

| | |
|---|---|
| Mover | `W` `A` `S` `D` |
| Correr | `Shift` |
| Agachar / deslizar | `Ctrl` |
| Pular / escalar | `Espaço` |
| Atirar / mirar | botão esquerdo / direito |
| Recarregar | `R` |
| Trocar arma | `Q` ou `1` `2` `3` |
| Modo de tiro | `B` |
| Corpo a corpo | `V` |
| Granada | `G` |
| Pausar | `Esc` |

Teclas de diagnóstico: `F3` nomes sobre os inimigos, `F4` estado do pool,
`F5` identificar objeto na mira, `F6` despejar configurações.

## Build

```bash
npm run build      # gera dist/
npm run preview    # serve o build local
```

A `base` está como `'./'`, então o build funciona tanto na raiz de um domínio
quanto numa subpasta — que é como o GitHub Pages serve um repositório comum.

Para conferir que nada quebrou em subpasta:

```bash
node tools/subpasta.mjs ./dist shots/build-subpasta.png
```

Ele sobe um servidor estático em `/operacao-rio-agi/`, carrega o jogo e falha se
aparecer qualquer 404 ou erro de página.

> **Em JavaScript, use `import.meta.env.BASE_URL` para montar caminho de asset.**
> O Vite reescreve caminho absoluto em HTML e CSS, mas não dentro de string de
> JS — um `'/audio/...'` cru funciona em dev e dá 404 publicado em subpasta.

Outros testes:

```bash
node tools/smoke.mjs       # as 5 páginas sobem sem erro de console
node tools/robustez.mjs    # localStorage corrompido e escape do killfeed
```

## Publicar no GitHub Pages

O workflow em `.github/workflows/pages.yml` faz build e publica a cada push em
`main` ou `master`. Só é preciso, uma vez, em **Settings → Pages**, escolher
*Source: GitHub Actions*.

Publicado em <https://inteligenciamilgrau.github.io/rioagi/> — repositório de
projeto, então o jogo serve numa subpasta. É por isso que a `base` é relativa e
que caminho de asset em JS passa por `import.meta.env.BASE_URL`.

## Estrutura

```
src/
  core/       engine, render, pós-processamento, configurações
  world/      geração da favela, terreno, casas, props, vegetação, colisão
  player/     movimento, câmera, armas, viewmodel
  ai/         inimigos, percepção, navegação, ragdoll
  fx/         áudio, partículas, tracers, decalques
  gameplay/   progressão, drops, música
  ui/         menu, HUD, abertura
tools/        ferramentas de diagnóstico (Playwright headless)
test/         páginas isoladas de teste
```

Documentos: [ARCHITECTURE.md](ARCHITECTURE.md) (contrato entre módulos),
[CRITICA.md](CRITICA.md) (régua de qualidade visual),
[HISTORIA.md](HISTORIA.md) (cânone narrativo), [NOTES.md](NOTES.md).

## Sobre os assets em `public/`

- `public/capa/` — arte de capa e logotipo (0,70 MB, WebP).
- `public/audio/musica/` — trilha sonora original do jogo (15,4 MB, MP3 VBR ~124 kbps).

Os efeitos sonoros não estão aqui: são **sintetizados em tempo de execução** pelo
`AudioEngine`, sem nenhum arquivo de áudio. Só a trilha musical é streaming.

Ambos já passaram por uma rodada de compressão, com o total saindo de 29,3 MB
para 16,1 MB:

| | antes | depois |
|---|---|---|
| arte | PNG 5,05 MB | **WebP 0,70 MB** |
| trilha | MP3 ~190 kbps, 24,2 MB | **MP3 VBR ~124 kbps, 15,4 MB** |

**PNG é o formato errado para arte fotográfica** — sem perdas, ótimo para
diagrama e péssimo para pintura. WebP resolve os dois casos daqui, inclusive o
logotipo, que precisa de canal alfa.

A trilha foi reencodada com `ffmpeg -c:a libmp3lame -q:a 6 -joint_stereo 1`. Se
você tiver os originais sem perda em algum lugar, **reencode a partir deles** —
o que está aqui já é geração dois.

Para conferir que as faixas continuam decodificando no navegador:

```bash
node tools/faixas.mjs
```

A arte vem em **duas camadas separadas** — `capa_foto.webp` sem texto e
`capa_titulo.webp` só com o logotipo, fundo transparente. É o que permite ao
logotipo animar sozinho na abertura e ficar nítido em qualquer resolução.
Detalhes em `public/capa/LEIA-ME.txt`.
