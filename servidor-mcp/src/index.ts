/**
 * Entrada do servidor MCP: transporte Streamable HTTP na porta 7301, endpoint
 * unico /mcp.
 *
 * O SDK v2 fala o Streamable HTTP moderno (revisao 2026-07-28) via
 * createMcpHandler, que devolve um handler web-standard `fetch(Request)`. Aqui
 * fazemos a ponte para o servidor http do Node e registramos cada request no
 * stderr com metodo, id e traceparent (quando vier no _meta).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { buildServer, criarCodec, NOME_SERVIDOR } from "./servidor.ts";

const PORTA = Number(process.env.MCP_PORT ?? 7301);
const HOST = process.env.MCP_HOST ?? "127.0.0.1";
const CAMINHO = process.env.MCP_PATH ?? "/mcp";

// --- Segredo do requestState (nunca hardcoded) ------------------------------

function resolverSegredo(): string {
  const env = process.env.REQUEST_STATE_SECRET;
  if (env && env.length > 0) {
    if (Buffer.byteLength(env, "utf8") < 32) {
      process.stderr.write(
        "[mcp] ERRO: REQUEST_STATE_SECRET tem menos de 32 bytes. Gere um com: " +
          'python3 -c "import secrets; print(secrets.token_hex(32))"\n',
      );
      process.exit(1);
    }
    return env;
  }
  // Sem env: gera um efemero para o caminho feliz nao travar, mas AVISA que um
  // retry apos restart so funciona com um REQUEST_STATE_SECRET fixo.
  const efemero = randomBytes(32).toString("hex");
  process.stderr.write(
    "[mcp] AVISO: REQUEST_STATE_SECRET nao definido; usando um segredo efemero. " +
      "O retry de MRTR nao sobrevive a um restart. Defina REQUEST_STATE_SECRET para producao/avaliacao.\n",
  );
  return efemero;
}

const codec = criarCodec(resolverSegredo());

// Factory chamado uma vez por request HTTP (o modelo stateless do transporte).
// O codec e compartilhado por closure entre as instancias.
const handler = createMcpHandler(async () => buildServer(codec), {
  onerror: (e: unknown) => process.stderr.write(`[mcp] onerror: ${e instanceof Error ? e.message : String(e)}\n`),
});

// --- Ponte node:http <-> web Request/Response -------------------------------

function lerCorpo(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const partes: Buffer[] = [];
    req.on("data", (c) => partes.push(c));
    req.on("end", () => resolve(Buffer.concat(partes)));
    req.on("error", reject);
  });
}

function registrar(corpo: Buffer): void {
  if (corpo.length === 0) return;
  let json: unknown;
  try {
    json = JSON.parse(corpo.toString("utf8"));
  } catch {
    return;
  }
  const itens = Array.isArray(json) ? json : [json];
  for (const item of itens) {
    if (!item || typeof item !== "object") continue;
    const m = item as { method?: unknown; id?: unknown; params?: { _meta?: Record<string, unknown> } };
    const traceparent = m.params?._meta?.["traceparent"];
    process.stderr.write(
      `[mcp] method=${String(m.method)} id=${JSON.stringify(m.id)} traceparent=${traceparent ? JSON.stringify(traceparent) : "-"}\n`,
    );
  }
}

const servidor = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? HOST}`);
    if (!url.pathname.startsWith(CAMINHO)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }

    const corpo = await lerCorpo(req);
    registrar(corpo);

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
      else if (v != null) headers.set(k, v);
    }
    const temCorpo = req.method !== "GET" && req.method !== "HEAD";
    const webReq = new Request(url.toString(), {
      method: req.method,
      headers,
      body: temCorpo && corpo.length ? corpo : undefined,
      duplex: temCorpo && corpo.length ? "half" : undefined,
    } as RequestInit);

    const webRes = await handler.fetch(webReq);
    res.statusCode = webRes.status;
    webRes.headers.forEach((valor, chave) => res.setHeader(chave, valor));
    res.end(Buffer.from(await webRes.arrayBuffer()));
  } catch (e) {
    process.stderr.write(`[mcp] erro no request: ${e instanceof Error ? e.stack : String(e)}\n`);
    res.statusCode = 500;
    res.end(String(e));
  }
});

servidor.listen(PORTA, HOST, () => {
  process.stderr.write(`[mcp] ${NOME_SERVIDOR} em http://${HOST}:${PORTA}${CAMINHO} (Streamable HTTP, revisao 2026-07-28)\n`);
});
