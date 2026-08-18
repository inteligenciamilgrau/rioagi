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
      /* A recusa precisa dizer O MOTIVO, nao so que nao deu.
       *
       * O caso comum e traicoeiro: o kit SO entra na mochila quando a vida esta
       * cheia (com vida baixa ele e usado na hora, no chao). Ou seja, logo depois
       * de guardar um kit, apertar usar bate exatamente na condicao de recusa.
       * Dizer "nada para usar" ali parece defeito — o jogador acabou de ver o
       * item entrar. Dizer "vida ja esta cheia" fecha a duvida na hora. */
      this.ctx.hud?.aviso?.(this._motivoDaRecusa(), 1400);
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

  /** Frase que explica por que nada pode ser usado agora. */
  _motivoDaRecusa() {
    if (this.total() === 0) return 'MOCHILA VAZIA';
    const jog = this.ctx.player;
    const temCura = this.itens.kit > 0 || this.itens.suprimento > 0;
    const temMun = this.itens.municao > 0 || this.itens.suprimento > 0;
    const vidaCheia = !jog || jog.health >= jog.maxHealth;
    const munCheia = !this.ctx.pickups?._faltaMunicao?.();
    if (temCura && temMun) return 'VIDA E MUNIÇÃO JÁ ESTÃO CHEIAS';
    if (temCura && vidaCheia) return 'VIDA JÁ ESTÁ CHEIA — GUARDE PARA DEPOIS';
    if (temMun && munCheia) return 'MUNIÇÃO JÁ ESTÁ CHEIA — GUARDE PARA DEPOIS';
    return 'NADA PARA USAR AGORA';
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
