/**
 * O servidor MCP: tres tools, um resource e o ciclo completo de MRTR na reserva.
 *
 * O MRTR (multi-request tool response) e a resposta do MCP a ausencia de sessao:
 * quando a sala esta ocupada, `reservar_sala` NAO chama o cliente de volta (no
 * transporte stateless nao ha canal de volta) — ela TERMINA a resposta com
 * resultType `input_required`, uma elicitation em form mode e um `requestState`
 * opaco e assinado. O cliente devolve depois um retry com `inputResponses` + o
 * mesmo `requestState`, e a tool conclui. Todo o estado viaja no requestState;
 * o servidor nao guarda nada entre as duas chamadas.
 */
import { z } from "zod";
import {
  McpServer,
  inputRequired,
  acceptedContent,
  createRequestStateCodec,
} from "@modelcontextprotocol/server";
import {
  ERRO_SEM_ALTERNATIVA,
  POLITICA_VERSAO,
  alternativas,
  conflitosDe,
  consultarDisponibilidade,
  criarReserva,
  listarSalas,
  politicaTexto,
  validar,
  type ReservaCriada,
} from "./dominio.ts";

export const NOME_SERVIDOR = "central-de-salas";
export const VERSAO_SERVIDOR = "1.0.0";

// Chave (interna) do inputRequests. O cliente devolve exatamente a mesma chave
// no inputResponses; o texto em si nao e fixado pela spec.
const CHAVE_ELICIT = "escolha_de_sala";

/** Conteudo selado dentro do requestState: o pedido original, integro. */
export interface EstadoSelado {
  sala: string;
  inicio: string;
  fim: string;
  responsavel: string;
}

export type Codec = ReturnType<typeof createRequestStateCodec<EstadoSelado>>;

/**
 * Cria o codec do requestState. A chave vem de fora (env), nunca do codigo, e
 * precisa ter no minimo 32 bytes. Assinatura HMAC-SHA256: o conteudo e legivel,
 * mas nao adulteravel — um requestState alterado falha em codec.verify e o SDK
 * responde -32602.
 */
export function criarCodec(segredo: string): Codec {
  return createRequestStateCodec<EstadoSelado>({
    key: segredo,
    ttlSeconds: 15 * 60, // expiracao entre 5 e 30 minutos
  });
}

// --- Helpers de resultado ---------------------------------------------------

function erro(mensagem: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: mensagem }] };
}

function completo<T extends object>(structured: T) {
  return {
    structuredContent: structured,
    content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
  };
}

// --- Schemas de saida (declarados; o SDK os expoe em tools/list) ------------

const salaOut = z.object({
  id: z.string(),
  nome: z.string(),
  capacidade: z.number().int(),
  recursos: z.array(z.string()),
});

const disponibilidadeOut = z.object({
  sala: z.string(),
  livre: z.boolean(),
  conflitos: z.array(
    z.object({ id: z.string(), inicio: z.string(), fim: z.string(), responsavel: z.string() }),
  ),
});

const RESERVA_RECUSADA = {
  reserva: null,
  reservado: false,
  sala: null,
  inicio: null,
  fim: null,
  responsavel: null,
  politica: null,
  motivo: "recusado",
};

/** Constroi um servidor MCP novo (o factory do createMcpHandler chama por request). */
export function buildServer(codec: Codec): McpServer {
  const server = new McpServer(
    { name: NOME_SERVIDOR, version: VERSAO_SERVIDOR },
    {
      capabilities: { tools: {}, resources: {} },
      // Integridade do requestState: o SDK roda verify ANTES do handler; se falhar
      // (adulterado/expirado) responde -32602 sem chegar na tool.
      requestState: { verify: codec.verify },
    },
  );

  // Resource: a politica de uso. quem controla e a aplicacao.
  server.registerResource(
    "politica",
    "politica://uso",
    { title: "Politica de uso das salas", mimeType: "text/markdown" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: politicaTexto() }],
    }),
  );

  server.registerTool(
    "listar_salas",
    {
      title: "Listar salas",
      description: "Lista todas as salas com capacidade e recursos.",
      inputSchema: z.object({}),
      outputSchema: z.object({ salas: z.array(salaOut) }),
    },
    async () => completo({ salas: listarSalas() }),
  );

  server.registerTool(
    "consultar_disponibilidade",
    {
      title: "Consultar disponibilidade",
      description: "Diz se uma sala esta livre no intervalo, e quais reservas conflitam.",
      inputSchema: z.object({ sala: z.string(), inicio: z.string(), fim: z.string() }),
      outputSchema: disponibilidadeOut,
    },
    async (args) => {
      const r = consultarDisponibilidade(args.sala, args.inicio, args.fim);
      if ("erro" in r) return erro(r.erro.mensagem);
      return completo(r.disponibilidade);
    },
  );

  server.registerTool(
    "reservar_sala",
    {
      title: "Reservar sala",
      description: "Reserva uma sala. Se o intervalo estiver ocupado, pergunta qual alternativa usar.",
      inputSchema: z.object({
        sala: z.string(),
        inicio: z.string(),
        fim: z.string(),
        responsavel: z.string(),
      }),
      // Sem outputSchema aqui, de proposito: reservar_sala pode terminar em
      // input_required (MRTR), que nao carrega structuredContent. O cliente MCP
      // v2 valida a saida contra o outputSchema declarado e recusaria essa perna
      // ("has an output schema but did not return structured content"). As outras
      // tools, que sempre respondem completo, declaram outputSchema normalmente.
    },
    async (args, ctx) => {
      // --- Retry leg: o requestState ja foi verificado e decodificado pelo SDK.
      const selado = ctx.mcpReq.requestState<EstadoSelado>();
      if (selado) {
        const escolhido = acceptedContent(ctx.mcpReq.inputResponses, CHAVE_ELICIT) as
          | { sala?: string }
          | undefined;
        if (!escolhido?.sala) {
          // decline/cancel: conclui sem reservar, sem isError.
          return completo(RESERVA_RECUSADA);
        }
        // Argumentos do retry sao nao-confiaveis: usamos os valores SELADOS para
        // inicio/fim/responsavel; a sala vem da escolha na elicitation.
        const criada: ReservaCriada = criarReserva(
          escolhido.sala,
          selado.inicio,
          selado.fim,
          selado.responsavel,
        );
        return completo(criada);
      }

      // --- Primeira chamada.
      const invalido = validar(args.sala, args.inicio, args.fim);
      if (invalido) return erro(invalido.mensagem);

      if (conflitosDe(args.sala, args.inicio, args.fim).length === 0) {
        return completo(criarReserva(args.sala, args.inicio, args.fim, args.responsavel));
      }

      const alts = alternativas(args.sala, args.inicio, args.fim);
      if (alts.length === 0) return erro(ERRO_SEM_ALTERNATIVA);

      // Conflito com alternativas: termina a resposta pedindo a escolha (MRTR).
      // O SDK deriva a capability exigida (elicitation.form) da propria elicit e,
      // se o cliente nao a declarou, responde -32021 sozinho.
      const requestState = await codec.mint({
        sala: args.sala,
        inicio: args.inicio,
        fim: args.fim,
        responsavel: args.responsavel,
      });
      return inputRequired({
        inputRequests: {
          [CHAVE_ELICIT]: inputRequired.elicit({
            message: "A sala pedida esta ocupada nesse intervalo. Escolha uma alternativa.",
            requestedSchema: {
              type: "object",
              properties: {
                sala: {
                  type: "string",
                  title: "Sala",
                  description: "Sala alternativa escolhida",
                  enum: alts,
                },
              },
              required: ["sala"],
            },
          }),
        },
        requestState,
      });
    },
  );

  return server;
}

export { POLITICA_VERSAO };
