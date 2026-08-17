/**
 * EventBus — pub/sub sincrono, zero alocacao no caminho quente.
 * Contrato de nomes de eventos: ver ARCHITECTURE.md
 */
export class EventBus {
  constructor() {
    /** @type {Map<string, Function[]>} */
    this._map = new Map();
    this._depth = 0;
    this._pendingOff = [];
  }

  on(name, fn) {
    let list = this._map.get(name);
    if (!list) { list = []; this._map.set(name, list); }
    list.push(fn);
    return () => this.off(name, fn);
  }

  once(name, fn) {
    const wrap = (p) => { this.off(name, wrap); fn(p); };
    return this.on(name, wrap);
  }

  off(name, fn) {
    // Remocao durante emit e adiada para nao embaralhar o array em iteracao.
    if (this._depth > 0) { this._pendingOff.push([name, fn]); return; }
    const list = this._map.get(name);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i !== -1) list.splice(i, 1);
  }

  emit(name, payload) {
    const list = this._map.get(name);
    if (!list || list.length === 0) return;
    this._depth++;
    // Itera por indice sobre copia estavel de tamanho para tolerar `on` durante emit.
    const n = list.length;
    for (let i = 0; i < n; i++) {
      const fn = list[i];
      if (!fn) continue;
      try { fn(payload); }
      catch (err) { console.error(`[EventBus] handler de "${name}" lancou:`, err); }
    }
    this._depth--;
    if (this._depth === 0 && this._pendingOff.length) {
      for (const [n2, f2] of this._pendingOff) this.off(n2, f2);
      this._pendingOff.length = 0;
    }
  }

  clear() { this._map.clear(); this._pendingOff.length = 0; this._depth = 0; }
}
