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

    time: { dt: 0, elapsed: 0, frame: 0 },
    state: 'menu',   // 'menu' | 'jogando' | 'pausado' | 'morto'
    debug: { enabled: false, stats: null, wireframe: false, freeCam: false },
  };
}
