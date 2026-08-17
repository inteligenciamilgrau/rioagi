/**
 * Input — teclado, mouse com pointer lock, gamepad.
 * Delta de mouse acumula entre frames e e zerado em update().
 * Nenhum outro modulo adiciona listener de input.
 */

const ACTION_KEYS = {
  forward:  ['KeyW', 'ArrowUp'],
  back:     ['KeyS', 'ArrowDown'],
  left:     ['KeyA', 'ArrowLeft'],
  right:    ['KeyD', 'ArrowRight'],
  jump:     ['Space'],
  crouch:   ['ControlLeft', 'KeyC'],
  sprint:   ['ShiftLeft'],
  reload:   ['KeyR'],
  use:      ['KeyF'],
  melee:    ['KeyV'],
  grenade:  ['KeyG'],
  swap:     ['KeyQ'],
  firemode: ['KeyB'],
  weapon1:  ['Digit1'],
  weapon2:  ['Digit2'],
  weapon3:  ['Digit3'],
  inspect:  ['KeyH'],
  pause:    ['Escape'],
};

export class Input {
  constructor(canvas, bus) {
    this.canvas = canvas;
    this.bus = bus;
    this.enabled = false;
    this.locked = false;

    this.keys = new Set();
    this._pressedThisFrame = new Set();
    this._releasedThisFrame = new Set();

    this.mouseDX = 0; this.mouseDY = 0;
    this.wheel = 0;
    this.buttons = [false, false, false];
    this._btnPressed = [false, false, false];
    this._btnReleased = [false, false, false];

    this.gamepadIndex = null;
    this.stickMove = { x: 0, y: 0 };
    this.stickLook = { x: 0, y: 0 };

    this._bind();
  }

  _bind() {
    const onKeyDown = (e) => {
      if (e.repeat) return;
      // Nao sequestra atalhos do navegador com modificadores.
      if (e.ctrlKey && e.code !== 'ControlLeft') return;
      this.keys.add(e.code);
      this._pressedThisFrame.add(e.code);
      if (this.locked && e.code !== 'Escape') e.preventDefault();
    };
    const onKeyUp = (e) => {
      this.keys.delete(e.code);
      this._releasedThisFrame.add(e.code);
    };
    const onMouseMove = (e) => {
      if (!this.locked) return;
      // movementX/Y ja vem em pixels de dispositivo com aceleracao do SO aplicada.
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
    };
    const onMouseDown = (e) => {
      if (!this.locked) return;
      if (e.button < 3) { this.buttons[e.button] = true; this._btnPressed[e.button] = true; }
      e.preventDefault();
    };
    const onMouseUp = (e) => {
      if (e.button < 3) { this.buttons[e.button] = false; this._btnReleased[e.button] = true; }
    };
    const onWheel = (e) => { if (this.locked) { this.wheel += Math.sign(e.deltaY); e.preventDefault(); } };
    const onContext = (e) => { if (this.locked) e.preventDefault(); };
    const onLockChange = () => {
      this.locked = document.pointerLockElement === this.canvas;
      this.bus?.emit(this.locked ? 'input:locked' : 'input:unlocked', {});
      if (!this.locked) { this.keys.clear(); this.buttons = [false, false, false]; }
    };
    const onBlur = () => { this.keys.clear(); this.buttons = [false, false, false]; };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('contextmenu', onContext);
    window.addEventListener('blur', onBlur);
    document.addEventListener('pointerlockchange', onLockChange);
    window.addEventListener('gamepadconnected', (e) => { this.gamepadIndex = e.gamepad.index; });
    window.addEventListener('gamepaddisconnected', () => { this.gamepadIndex = null; });

    this._unbind = () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('contextmenu', onContext);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('pointerlockchange', onLockChange);
    };
  }

  requestLock() { this.canvas.requestPointerLock?.(); }
  releaseLock() { document.exitPointerLock?.(); }

  // --- consultas por acao ---
  isDown(action) {
    const codes = ACTION_KEYS[action];
    if (!codes) return false;
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }
  wasPressed(action) {
    const codes = ACTION_KEYS[action];
    if (!codes) return false;
    for (const c of codes) if (this._pressedThisFrame.has(c)) return true;
    return false;
  }
  wasReleased(action) {
    const codes = ACTION_KEYS[action];
    if (!codes) return false;
    for (const c of codes) if (this._releasedThisFrame.has(c)) return true;
    return false;
  }

  get fireDown()   { return this.buttons[0] || this._padButton(7); }
  get firePressed(){ return this._btnPressed[0]; }
  get adsDown()    { return this.buttons[2] || this._padButton(6); }

  /** Vetor de movimento bruto, ja normalizado se diagonal. */
  getMoveVector(out) {
    let x = (this.isDown('right') ? 1 : 0) - (this.isDown('left') ? 1 : 0);
    let y = (this.isDown('forward') ? 1 : 0) - (this.isDown('back') ? 1 : 0);
    if (this.gamepadIndex !== null) {
      const gp = navigator.getGamepads?.()[this.gamepadIndex];
      if (gp) {
        const dz = 0.18;
        const ax = gp.axes[0] ?? 0, ay = gp.axes[1] ?? 0;
        if (Math.abs(ax) > dz) x += ax;
        if (Math.abs(ay) > dz) y -= ay;
      }
    }
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    out.x = x; out.y = y;
    return out;
  }

  _padButton(i) {
    if (this.gamepadIndex === null) return false;
    const gp = navigator.getGamepads?.()[this.gamepadIndex];
    return !!(gp && gp.buttons[i] && gp.buttons[i].value > 0.5);
  }

  /** Consome o delta acumulado do mouse (+ stick direito do gamepad). */
  consumeLook(out) {
    let dx = this.mouseDX, dy = this.mouseDY;
    if (this.gamepadIndex !== null) {
      const gp = navigator.getGamepads?.()[this.gamepadIndex];
      if (gp) {
        const dz = 0.15, gain = 620; // px-equivalente por segundo em stick cheio
        const ax = gp.axes[2] ?? 0, ay = gp.axes[3] ?? 0;
        // Curva de resposta quadratica: precisao no centro, velocidade nas bordas.
        if (Math.abs(ax) > dz) dx += Math.sign(ax) * (Math.abs(ax) - dz) ** 2 * gain * (1 / 60);
        if (Math.abs(ay) > dz) dy += Math.sign(ay) * (Math.abs(ay) - dz) ** 2 * gain * (1 / 60);
      }
    }
    out.x = dx; out.y = dy;
    return out;
  }

  /** Chamado no fim do frame pelo main loop. */
  endFrame() {
    this.mouseDX = 0; this.mouseDY = 0; this.wheel = 0;
    this._pressedThisFrame.clear();
    this._releasedThisFrame.clear();
    this._btnPressed[0] = this._btnPressed[1] = this._btnPressed[2] = false;
    this._btnReleased[0] = this._btnReleased[1] = this._btnReleased[2] = false;
  }

  dispose() { this._unbind?.(); }
}
