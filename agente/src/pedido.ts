/**
 * Interpretacao dos pedidos em formato fixo. Nada de linguagem natural, nada de
 * LLM: o agente decide por regra e e deterministico.
 *
 *   reservar sala=<id> inicio=<iso8601> fim=<iso8601> responsavel=<nome>
 *   escolha=<id da sala>   |   escolha=recusar
 */
export interface PedidoReserva {
  tipo: "reservar";
  sala: string;
  inicio: string;
  fim: string;
  responsavel: string;
}

export interface PedidoEscolha {
  tipo: "escolha";
  valor: string;
}

export type Pedido = PedidoReserva | PedidoEscolha | { tipo: "invalido" };

export function interpretar(texto: string): Pedido {
  const t = texto.trim();

  const escolha = t.match(/^escolha=(\S+)\s*$/);
  if (escolha) return { tipo: "escolha", valor: escolha[1] };

  if (t.startsWith("reservar")) {
    const sala = t.match(/\bsala=(\S+)/)?.[1];
    const inicio = t.match(/\binicio=(\S+)/)?.[1];
    const fim = t.match(/\bfim=(\S+)/)?.[1];
    const responsavel = t.match(/\bresponsavel=(.+?)\s*$/)?.[1];
    if (sala && inicio && fim && responsavel) {
      return { tipo: "reservar", sala, inicio, fim, responsavel };
    }
  }

  return { tipo: "invalido" };
}
