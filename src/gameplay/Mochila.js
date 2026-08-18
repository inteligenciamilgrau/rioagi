/**
 * Mochila — guarda itens que o jogador pisa mas ainda nao precisa.
 *
 * ## O problema que ela resolve
 * A coleta e automatica por proximidade. Antes, um item que nao servisse AGORA
 * (kit com a vida cheia, municao com a reserva cheia) era simplesmente ignorado
 * e ficava no chao — a ideia era "o jogador volta nele depois". Na pratica isso
 * lia como defeito: a pessoa entra numa sala, passa por cima de tudo, nada
 * acontece, e ela conclui que a coleta esta quebrada. E raramente alguem volta:
 * o item fica num comodo que ja foi limpo, longe de onde a briga esta.
 *
 * Agora o item entra na mochila e o jogador usa quando precisar.
 *
 * ## Por que ha limite por tipo
 * Sem teto, a mochila vira deposito e o recurso deixa de ser decisao: o jogador
 * acumula vinte kits e nunca mais pensa em vida. O limite baixo mantem a escolha
 * de quando gastar, que e a graca do item.
 */

/** Teto por tipo. Baixo de proposito — ver nota acima. */
export const CAPACIDADE = {
  municao: 3,
  kit: 3,
  suprimento: 2,
};

/** Ordem de preferencia quando o jogador aperta usar sem escolher. */
const PRIORIDADE = ['kit', 'suprimento', 'municao'];

export class Mochila {
  constructor(ctx) {
    this.ctx = ctx;
    /** @type {Record<string, number>} */
    this.itens = { municao: 0, kit: 0, suprimento: 0 };
  }

  total() {
    return this.itens.municao + this.itens.kit + this.itens.suprimento;
  }

  temEspaco(tipo) {
    return (this.itens[tipo] ?? 0) < (CAPACIDADE[tipo] ?? 0);
  }

  /**
   * Guarda um item.
   * @returns {boolean} false se nao couber (o item fica no chao)
   */
  guardar(tipo) {
    if (!this.temEspaco(tipo)) return false;
    this.itens[tipo]++;
    this._avisarMudanca();
    return true;
  }

  /**
   * Qual item o comando de usar gastaria agora — ou null se nenhum ajudaria.
   *
   * Consultar isto ANTES de gastar e o que permite ao HUD dizer o que vai
   * acontecer, e o que impede o jogador de queimar um kit a toa com a vida
   * cheia. Sem essa consulta, "usar" viraria loteria.
   */
  oQueUsaria() {
    for (const tipo of PRIORIDADE) {
      if (this.itens[tipo] <= 0) continue;
      if (this.ctx.pickups?.serviria?.(tipo)) return tipo;
    }
    return null;
  }

  /**
   * Usa o melhor item disponivel.
   * @returns {boolean} true se algo foi gasto
   */
  usar() {
    const tipo = this.oQueUsaria();
    if (!tipo) {
      // Diferenciar as duas recusas: mochila vazia e um problema, mochila cheia
      // com nada util agora e outro. Dizer "vazia" quando ha 3 kits e mentir.
      const msg = this.total() === 0 ? 'MOCHILA VAZIA' : 'NADA PARA USAR AGORA';
      this.ctx.hud?.aviso?.(msg, 900);
      return false;
    }
    const r = this.ctx.pickups?.aplicarEfeito?.(tipo);
    if (!r?.usou) return false;

    this.itens[tipo]--;
    this._avisarMudanca();
    this.ctx.hud?.aviso?.(`${r.rotulo}  ${r.partes.join('  ')}`, 1200);
    this.ctx.audio?.recarga?.('magin');
    this.ctx.bus?.emit('mochila:usou', { tipo });
    return true;
  }

  /** Zera no reinicio de partida. */
  reset() {
    this.itens.municao = 0;
    this.itens.kit = 0;
    this.itens.suprimento = 0;
    this._avisarMudanca();
  }

  _avisarMudanca() {
    this.ctx.bus?.emit('mochila:mudou', { itens: { ...this.itens } });
  }
}
