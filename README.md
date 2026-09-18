# A Ponte: um agente A2A com MCP por dentro

Servidor MCP (Streamable HTTP) + agente A2A que consome esse servidor por dentro
(como host MCP) e se oferece por fora (como servidor A2A v1.0). Domínio: reserva
das cinco salas da Hill Valley Tech.

O que atravessa a fronteira entre os dois protocolos é **estado nomeado
explicitamente**: o `requestState` do MRTR (MCP) e a `Task` do A2A se encontram
no agente. Quando o servidor MCP responde `input_required`, o agente **interrompe
a Task** (`TASK_STATE_INPUT_REQUIRED`), guarda o `requestState` ligado àquela
Task e, quando a escolha chega, **repete o `tools/call` com um id novo**, levando
`inputResponses` + o `requestState` ecoado.

- **Linguagem/SDK:** Node.js 20+ (ESM, TypeScript via `tsx`), SDK oficial do MCP
  v2 — `@modelcontextprotocol/server@2.0.0` no servidor e
  `@modelcontextprotocol/client@2.0.0` no agente, alinhados à revisão
  `2026-07-28` da spec. A2A v1.0 sobre JSON-RPC 2.0 (HTTP) é implementado
  diretamente (o binding é um envelope JSON-RPC simples).
- **Sem LLM** no caminho de execução: o agente interpreta o pedido em formato
  fixo e decide por regra. Determinístico.
- **Dois processos separados**, falando por HTTP.

```
servidor-mcp/   -> porta 7301, endpoint /mcp   (tools, resource, MRTR)
agente/         -> porta 7300, endpoint /a2a   + /.well-known/agent-card.json
dados/          -> salas, reservas iniciais, política (NÃO alterado)
validador/      -> validar.py (NÃO alterado)
exemplos/       -> wire dos dois protocolos (NÃO alterado)
```

## Como rodar

A partir de um clone limpo, com **Node.js 20+** e **Python 3.10+**.

**1. Gere e exporte o segredo de integridade do `requestState`** (mínimo 32 bytes,
nunca versionado). Use o **mesmo valor** nos dois passos seguintes e mantenha-o
fixo entre reinícios (o `requestState` precisa continuar válido após um restart):

```bash
export REQUEST_STATE_SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")
```

**2. Suba o servidor MCP** (terminal 1 — deixe o stderr visível):

```bash
cd servidor-mcp && npm install && npm start
```

**3. Suba o agente A2A** (terminal 2, no mesmo shell onde exportou o segredo — o
agente não precisa do segredo, mas o MCP sim):

```bash
cd agente && npm install && npm start
```

**4. Confira o Agent Card e rode o validador** (terminal 3):

```bash
curl http://localhost:7300/.well-known/agent-card.json
python3 validador/validar.py --agente http://localhost:7300 --mcp http://localhost:7301
```

> Se `REQUEST_STATE_SECRET` não estiver definido, o servidor sobe com um segredo
> **efêmero** (e avisa no stderr): o caminho feliz e as 36 verificações passam,
> mas o retry de MRTR não sobrevive a um restart. Para a verificação de restart,
> exporte um segredo fixo como no passo 1.

Portas e caminhos são parametrizáveis por env (`MCP_PORT`, `MCP_PATH`,
`A2A_PORT`, `A2A_PATH`, `MCP_URL`), com os defaults que o validador espera.

## Onde a ponte acontece

A ponte vive em [`agente/src/ponte.ts`](agente/src/ponte.ts).

- **`input_required` do MCP → `TASK_STATE_INPUT_REQUIRED`:** em
  [`ponte.ts:79`](agente/src/ponte.ts#L79) o resultado `input_required` do
  servidor MCP é transformado em pausa da Task. O `requestState` opaco fica
  guardado na gaveta `task.pausa` (associada àquela Task, nunca exposta), e em
  [`ponte.ts:86`](agente/src/ponte.ts#L86) a Task vai para
  `TASK_STATE_INPUT_REQUIRED` com a linha exata `alternativas: <ids>`.
- **`requestState` de volta para o servidor:** na continuação, em
  [`ponte.ts:127`](agente/src/ponte.ts#L127), o agente chama
  `host.retomar(...)` levando `pausa.requestState` ecoado sem modificação. O
  cliente MCP em [`cliente-mcp.ts:105`](agente/src/cliente-mcp.ts#L105) monta o
  retry como um **novo `tools/call`** (id de JSON-RPC novo, gerado pelo SDK)
  com `inputResponses` na mesma chave + o `requestState`.

Do lado do servidor, o MRTR está em
[`servidor-mcp/src/servidor.ts`](servidor-mcp/src/servidor.ts): a tool termina a
resposta com `inputRequired({...})` em [`servidor.ts:210`](servidor-mcp/src/servidor.ts#L210)
(não há canal de volta no transporte stateless — o servidor **termina** pedindo
informação, não pergunta de forma síncrona), e no retry recupera o pedido selado
via `ctx.mcpReq.requestState()` em [`servidor.ts:170`](servidor-mcp/src/servidor.ts#L170).

## Decisões técnicas

- **Proteção do `requestState`:** HMAC-SHA256 via `createRequestStateCodec` do
  SDK ([`servidor.ts:60`](servidor-mcp/src/servidor.ts)). O conteúdo é legível
  (base64url), mas **assinado**: uma adulteração falha em `codec.verify` — que o
  SDK roda antes do handler (`requestState: { verify }`,
  [`servidor.ts:111`](servidor-mcp/src/servidor.ts#L111)) — e a resposta é
  `-32602`. A chave vem **de `REQUEST_STATE_SECRET`**, nunca do código, e exige
  no mínimo 32 bytes (o processo aborta se for menor).
- **Validade:** o `requestState` expira em **15 minutos** (`ttlSeconds`, dentro
  da faixa de 5 a 30 min exigida). Como todo o estado do pedido original viaja
  selado dentro dele, o servidor **não guarda nada em memória** entre o
  `input_required` e o retry — um retry apresentado depois de um restart do
  servidor MCP funciona, desde que o `REQUEST_STATE_SECRET` seja o mesmo.
- **Argumentos do retry não são confiáveis:** no retry o servidor usa os valores
  **selados** (`inicio`/`fim`/`responsavel`) e ignora os argumentos reenviados; a
  sala vem da escolha da elicitation ([`servidor.ts:170`](servidor-mcp/src/servidor.ts#L170)).
- **Estado das Tasks:** em memória, num `Map` em
  [`agente/src/tarefas.ts`](agente/src/tarefas.ts). Cada Task carrega uma gaveta
  interna `pausa` com o `requestState` + a chave do `inputRequests` + o `enum` de
  alternativas; a projeção pública `serializar()` omite essa gaveta, então o
  `requestState` nunca aparece em nenhuma resposta A2A (card, artifact ou
  mensagem). O estado pausado é **por Task**: dois pedidos em conflito, pausados
  ao mesmo tempo, concluem cada um com o seu próprio `requestState`.
- **Propagação do `traceparent`:** o agente extrai o `trace-id` do header
  `traceparent` da chamada A2A e o repassa no `traceparent` dentro do `_meta` de
  todos os requests MCP daquela Task, com **span-id novo, trace-id preservado**
  ([`cliente-mcp.ts`](agente/src/cliente-mcp.ts), função `traceparentDe`). O
  servidor MCP registra método, id e `traceparent` de cada request no stderr.
- **Determinismo:** sem LLM. Mesmo pedido, mesmo resultado; o cliente MCP é
  mantido vivo entre chamadas (recomendado), mas nenhum dos lados infere versão,
  capabilities ou contexto de request anterior — o envelope `_meta` viaja em
  cada request.
- **Limitação real do SDK, contornada sem reescrever o protocolo:** o cliente MCP
  v2 valida a saída de uma tool contra o `outputSchema` declarado e recusa uma
  perna que não traga `structuredContent` (`"Tool ... has an output schema but
  did not return structured content"`, `client/dist/index.mjs:4152`). Como
  `reservar_sala` pode terminar em `input_required` (que, por contrato, não
  carrega `structuredContent`), essa tool **não declara `outputSchema`** — as
  outras duas, que sempre respondem completo, declaram normalmente. A reserva
  concluída continua devolvendo todo o `structuredContent` exigido.

## Saída do validador

Última execução, com os dois processos recém-iniciados:

```
trace-id desta execucao: 595e2c27745f4a8c1c2ef2b7521b2520
procure esse valor no stderr do servidor MCP para conferir a propagacao do traceparent.

PASS 01 tools/list traz as tres tools
PASS 02 toda tool tem inputSchema de objeto
PASS 03 listar_salas devolve structuredContent e o mesmo JSON em texto
PASS 04 _meta sem protocolVersion devolve -32602 e HTTP 400
PASS 05 _meta sem clientCapabilities devolve -32602 e HTTP 400
PASS 06 tool inexistente e recusada, por -32602 ou por isError
PASS 07 resources/read de politica://uso devolve a politica
PASS 08 resources/read de URI inexistente devolve -32602
PASS 09 sala inexistente devolve isError com a mensagem exata
PASS 10 fora da janela devolve isError com a mensagem exata
PASS 11 duracao acima de 2h devolve isError com a mensagem exata
PASS 12 intervalo invertido devolve isError com a mensagem exata
PASS 13 conflito devolve input_required com inputRequests e requestState
PASS 14 a elicitation e form mode e oferece as alternativas na ordem certa
PASS 15 conflito sem a capability elicitation devolve -32021 e HTTP 400
PASS 16 retry com inputResponses e requestState conclui a reserva
PASS 17 requestState adulterado e rejeitado com -32602
PASS 18 argumentos adulterados no retry nao tomam efeito
PASS 19 recusa conclui sem reservar e sem isError
PASS 20 conflito sem alternativa possivel devolve isError com a mensagem exata

PASS 21 agent card responde 200 no well-known com JSON
PASS 22 o card declara a interface JSON-RPC com url e versao 1.0
PASS 23 o card declara a skill reservar-sala
PASS 24 SendMessage com sala livre conclui a Task
PASS 25 o artifact chama reserva e traz a versao da politica
PASS 26 GetTask devolve id, contextId e estado corrente
PASS 27 SendMessage com sala ocupada pausa a Task
PASS 28 a Task pausada lista as alternativas na ordem certa
PASS 29 escolha fora do enum mantem a Task pausada
PASS 30 a continuacao conclui a Task na sala escolhida
PASS 31 SendMessage em Task terminal e recusado
PASS 32 a recusa termina a Task em CANCELED
PASS 33 duas Tasks pausadas ao mesmo tempo concluem cada uma com a sua reserva
PASS 34 nenhuma resposta A2A carrega o requestState
PASS 35 sala inexistente termina a Task em FAILED com a mensagem da tool
PASS 36 o agente e deterministico: o mesmo pedido produz a mesma pausa

resumo: 36 passaram, 0 falharam, de 36 verificacoes
```

Além das 36 verificações automáticas, a persistência do `requestState` através de
um restart do servidor MCP (mesmo `REQUEST_STATE_SECRET`) foi verificada
manualmente: um `requestState` mintado antes do restart conclui a reserva no
retry apresentado depois dele.
