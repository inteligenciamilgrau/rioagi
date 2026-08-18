/**
 * GameContext — objeto compartilhado injetado em todo sistema.
 * Campos sao preenchidos progressivamente durante o boot (ver src/main.js).
 * Nenhum sistema deve assumir que um campo posterior existe em seu constructor;
 * so em init() e update().
 */
export function createContext() {
  return {
    // preenchido por Engine
    renderer: null,
    scene: null,
    camera: null,
    viewScene: null,
    viewCamera: null,
    clock: null,

    // infra
    bus: null,
    settings: null,
    input: null,

    // sistemas (preenchidos na ordem de boot)
    sky: null,
    lighting: null,
    materials: null,
    world: null,
    player: null,
    ai: null,
    fx: null,
    audio: null,
    hud: null,
    postfx: null,

    /* `scale` e a camera lenta: o `main.js` multiplica o dt por ela antes de
     * repassar aos sistemas. `dtReal` guarda o dt de PAREDE do mesmo quadro,
     * para quem precisa de relogio de verdade (contagem de encenacao, UI). */
    time: { dt: 0, dtReal: 0, elapsed: 0, frame: 0, scale: 1 },
    // 'caindo' e a encenacao da morte: o jogador ja perdeu, mas a camera
    // ainda esta desabando. Nem 'jogando' (ninguem simula) nem 'morto'
    // (a tela final ainda nao pode entrar).
    state: 'menu',   // 'menu' | 'jogando' | 'pausado' | 'caindo' | 'morto'
    debug: { enabled: false, stats: null, wireframe: false, freeCam: false },
  };
}
