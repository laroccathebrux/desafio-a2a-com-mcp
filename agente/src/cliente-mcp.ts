/**
 * O agente por dentro: host MCP. Um cliente MCP oficial (v2) falando Streamable
 * HTTP com o servidor :7301, como um cliente de verdade — nada de importar a
 * funcao da tool.
 *
 * Duas escolhas deliberadas:
 *  - `inputRequired.autoFulfill: false` + `allowInputRequired: true` por chamada:
 *    o cliente NAO responde a elicitation sozinho. A ponte precisa enxergar o
 *    input_required cru para pausar a Task e devolver a pergunta ao cliente A2A.
 *  - `versionNegotiation.mode: 'auto'`: sem isso o cliente fala a revisao legada
 *    e nunca anexa o envelope _meta da revisao 2026-07-28.
 *
 * O requestState e OPACO para o agente: ele guarda, ecoa, e nunca abre.
 */
import { randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport, isInputRequiredResult } from "@modelcontextprotocol/client";
import type {
  ArgumentosReserva,
  HostMcp,
  RespostaElicitation,
  ResultadoMcp,
} from "./host-mcp.ts";

const NOME_TOOL = "reservar_sala";
const URI_POLITICA = "politica://uso";

function traceparentDe(traceId?: string): string | undefined {
  if (!traceId) return undefined;
  // Mesmo trace-id, span-id novo (a spec permite renovar o span, nao o trace).
  return `00-${traceId}-${randomBytes(8).toString("hex")}-01`;
}

function meta(traceId?: string): { _meta?: Record<string, unknown> } {
  const tp = traceparentDe(traceId);
  return tp ? { _meta: { traceparent: tp } } : {};
}

function textoDe(resultado: any): string {
  return (resultado?.content ?? [])
    .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
    .join(" ")
    .trim();
}

function alternativasDe(inputRequests: any, chave: string): string[] {
  const schema = inputRequests?.[chave]?.params?.requestedSchema;
  const sala = schema?.properties?.sala ?? {};
  if (Array.isArray(sala.enum)) return sala.enum as string[];
  if (typeof sala.const === "string") return [sala.const];
  return [];
}

function mapear(resultado: any): ResultadoMcp {
  if (isInputRequiredResult(resultado)) {
    const chave = Object.keys(resultado.inputRequests ?? {})[0] ?? "";
    return {
      tipo: "input_required",
      chave,
      alternativas: alternativasDe(resultado.inputRequests, chave),
      requestState: resultado.requestState as string,
    };
  }
  if (resultado?.isError) {
    return { tipo: "erro", mensagem: textoDe(resultado) };
  }
  return { tipo: "complete", structured: resultado.structuredContent };
}

class ClienteMcp implements HostMcp {
  private tools: string[] | null = null;
  private politica: string | null = null;

  constructor(private readonly client: Client) {}

  async descobrirTools(traceId?: string): Promise<string[]> {
    if (this.tools) return this.tools;
    const res: any = await this.client.listTools(meta(traceId) as any);
    this.tools = (res.tools ?? []).map((t: any) => t.name);
    return this.tools!;
  }

  async politicaVersao(traceId?: string): Promise<string> {
    if (this.politica) return this.politica;
    const res: any = await this.client.readResource({ uri: URI_POLITICA, ...meta(traceId) } as any);
    const texto: string = res?.contents?.[0]?.text ?? "";
    this.politica = (texto.match(/versao:\s*(\S+)/)?.[1] ?? "").trim();
    return this.politica;
  }

  async reservar(args: ArgumentosReserva, traceId?: string): Promise<ResultadoMcp> {
    const resultado: any = await this.client.callTool(
      { name: NOME_TOOL, arguments: { ...args }, ...meta(traceId) } as any,
      { allowInputRequired: true } as any,
    );
    return mapear(resultado);
  }

  async retomar(
    args: ArgumentosReserva,
    chave: string,
    resposta: RespostaElicitation,
    requestState: string,
    traceId?: string,
  ): Promise<ResultadoMcp> {
    const resultado: any = await this.client.callTool(
      {
        name: NOME_TOOL,
        arguments: { ...args },
        inputResponses: { [chave]: resposta },
        requestState,
        ...meta(traceId),
      } as any,
      { allowInputRequired: true } as any,
    );
    return mapear(resultado);
  }
}

/** Conecta ao servidor MCP (com algumas tentativas) e devolve o host. */
export async function criarHostMcp(url: string): Promise<HostMcp> {
  const client = new Client(
    { name: "agente-central-de-salas", version: "1.0.0" },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: "auto" },
      inputRequired: { autoFulfill: false },
    } as any,
  );

  let ultimoErro: unknown;
  for (let tentativa = 1; tentativa <= 20; tentativa++) {
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      process.stderr.write(`[agente] conectado ao servidor MCP em ${url}\n`);
      return new ClienteMcp(client);
    } catch (e) {
      ultimoErro = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`nao consegui conectar ao servidor MCP em ${url}: ${String(ultimoErro)}`);
}
