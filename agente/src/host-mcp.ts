/**
 * Contrato do host MCP visto pela ponte. A implementacao concreta (cliente MCP
 * oficial falando Streamable HTTP com o servidor :7301) vive em cliente-mcp.ts.
 *
 * O ponto crucial: `reservar`/`retomar` devolvem o resultado CRU do servidor MCP,
 * inclusive o input_required com o requestState opaco. A ponte precisa enxergar
 * esse input_required para pausar a Task — por isso o host nao responde a
 * elicitation sozinho.
 */
export interface ArgumentosReserva {
  sala: string;
  inicio: string;
  fim: string;
  responsavel: string;
}

export interface ReservaStructured {
  reserva: string | null;
  reservado: boolean;
  sala: string | null;
  inicio: string | null;
  fim: string | null;
  responsavel: string | null;
  politica: string | null;
  motivo: string | null;
}

export type ResultadoMcp =
  | { tipo: "input_required"; chave: string; alternativas: string[]; requestState: string }
  | { tipo: "complete"; structured: ReservaStructured }
  | { tipo: "erro"; mensagem: string };

export interface RespostaElicitation {
  action: "accept" | "decline" | "cancel";
  content?: { sala: string };
}

export interface HostMcp {
  /** Garante o tools/list de descoberta e devolve os nomes das tools. */
  descobrirTools(traceId?: string): Promise<string[]>;
  /** Le o resource politica://uso e extrai a versao da primeira linha. */
  politicaVersao(traceId?: string): Promise<string>;
  /** Chamada inicial de reserva. */
  reservar(args: ArgumentosReserva, traceId?: string): Promise<ResultadoMcp>;
  /** Retry do MESMO tools/call, com id novo, levando inputResponses + requestState. */
  retomar(
    args: ArgumentosReserva,
    chave: string,
    resposta: RespostaElicitation,
    requestState: string,
    traceId?: string,
  ): Promise<ResultadoMcp>;
}
