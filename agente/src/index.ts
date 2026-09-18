/**
 * O agente por fora: servidor A2A v1.0 (binding JSON-RPC 2.0 sobre HTTP).
 *
 *   GET  /.well-known/agent-card.json  -> Agent Card
 *   POST /a2a                          -> SendMessage | GetTask
 *
 * Por dentro ele e host MCP: fala Streamable HTTP com o servidor :7301. A
 * costura das duas pontas esta em ponte.ts.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { agentCard } from "./card.ts";
import { Ponte } from "./ponte.ts";
import { criarHostMcp } from "./cliente-mcp.ts";
import type { Mensagem } from "./tarefas.ts";

const PORTA = Number(process.env.A2A_PORT ?? 7300);
const HOST = process.env.A2A_HOST ?? "127.0.0.1";
const CAMINHO_A2A = process.env.A2A_PATH ?? "/a2a";
const URL_MCP = process.env.MCP_URL ?? "http://localhost:7301/mcp";

function traceIdDe(req: IncomingMessage): string | undefined {
  const tp = req.headers["traceparent"];
  const valor = Array.isArray(tp) ? tp[0] : tp;
  const traceId = valor?.split("-")[1];
  return traceId && /^[0-9a-f]{32}$/.test(traceId) ? traceId : undefined;
}

function lerCorpo(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const partes: Buffer[] = [];
    req.on("data", (c) => partes.push(c));
    req.on("end", () => resolve(Buffer.concat(partes).toString("utf8")));
    req.on("error", reject);
  });
}

function enviarJson(res: ServerResponse, status: number, corpo: unknown): void {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(texto);
}

async function main(): Promise<void> {
  const urlA2A = `http://${HOST}:${PORTA}${CAMINHO_A2A}`;
  const host = await criarHostMcp(URL_MCP);
  const ponte = new Ponte(host);

  const servidor = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? HOST}`);

      if (req.method === "GET" && url.pathname === "/.well-known/agent-card.json") {
        enviarJson(res, 200, agentCard(urlA2A));
        return;
      }

      if (req.method === "POST" && url.pathname === CAMINHO_A2A) {
        const traceId = traceIdDe(req);
        const corpo = JSON.parse(await lerCorpo(req));
        const { id = null, method, params } = corpo ?? {};

        let resposta;
        if (method === "SendMessage") {
          resposta = await ponte.sendMessage(params?.message as Mensagem, traceId);
        } else if (method === "GetTask") {
          resposta = ponte.getTask(params?.id as string);
        } else {
          resposta = { error: { code: -32601, message: `Metodo desconhecido: ${method}` } };
        }

        const envelope: Record<string, unknown> = { jsonrpc: "2.0", id };
        if (resposta.error) envelope.error = resposta.error;
        else envelope.result = resposta.result;
        enviarJson(res, 200, envelope);
        return;
      }

      enviarJson(res, 404, { error: "not found" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      enviarJson(res, 200, { jsonrpc: "2.0", id: null, error: { code: -32603, message: msg } });
    }
  });

  servidor.listen(PORTA, HOST, () => {
    process.stderr.write(`[agente] A2A em http://${HOST}:${PORTA} (card em /.well-known/agent-card.json, rpc em ${CAMINHO_A2A})\n`);
    process.stderr.write(`[agente] host MCP -> ${URL_MCP}\n`);
  });
}

main().catch((e) => {
  process.stderr.write(`[agente] falha ao subir: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
