/**
 * Agent Card v1.0, publicado em /.well-known/agent-card.json.
 * A forma segue exemplos/wire/07-a2a-agent-card.json: na v1.0 a URL, o binding e
 * a versao de protocolo vivem dentro de supportedInterfaces[].
 */
export function agentCard(urlA2A: string) {
  return {
    name: "Central de Salas",
    description: "Reserva salas de reuniao da Hill Valley Tech.",
    provider: {
      organization: "Hill Valley Tech",
      url: "https://hillvalley.example",
    },
    version: "1.0.0",
    supportedInterfaces: [
      {
        url: urlA2A,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      },
    ],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "reservar-sala",
        name: "Reservar sala",
        description:
          "Reserva uma sala em um intervalo. Se houver conflito, pergunta qual alternativa usar.",
        tags: ["salas", "agenda"],
        inputModes: ["text/plain"],
        outputModes: ["text/plain"],
        examples: [
          "reservar sala=sala-garagem inicio=2026-11-03T14:00:00-03:00 fim=2026-11-03T15:00:00-03:00 responsavel=Marty",
        ],
      },
    ],
  };
}
