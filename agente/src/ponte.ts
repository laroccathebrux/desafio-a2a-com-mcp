/**
 * A PONTE. Aqui o input_required do MCP vira TASK_STATE_INPUT_REQUIRED, e a
 * escolha do cliente A2A vira o retry que devolve o requestState ao servidor MCP.
 *
 * O estado interrompido (Task pausada + requestState guardado) e o estado
 * terminal (Completed/Canceled/Failed) se encontram nesta camada. O agente
 * traduz protocolo: nao decide conflito, politica nem alternativas — isso e do
 * servidor MCP.
 */
import {
  acharTask,
  criarTask,
  estadoTerminal,
  serializar,
  transitar,
  novoArtifactId,
  type Mensagem,
  type Task,
} from "./tarefas.ts";
import { interpretar } from "./pedido.ts";
import type { ArgumentosReserva, HostMcp, ReservaStructured } from "./host-mcp.ts";

export interface RespostaRpc {
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const ok = (task: Task): RespostaRpc => ({ result: { task: serializar(task) } });
const falha = (code: number, message: string): RespostaRpc => ({ error: { code, message } });

export class Ponte {
  constructor(private readonly host: HostMcp) {}

  async sendMessage(message: Mensagem, traceId?: string): Promise<RespostaRpc> {
    if (message.taskId) return this.continuar(message, traceId);
    return this.iniciar(message, traceId);
  }

  getTask(id: string): RespostaRpc {
    const task = acharTask(id);
    if (!task) return falha(-32001, `Task nao encontrada: ${id}`);
    return ok(task);
  }

  // --- Abertura de uma Task nova -----------------------------------------

  private async iniciar(message: Mensagem, traceId?: string): Promise<RespostaRpc> {
    const pedido = interpretar(message.parts.map((p) => p.text).join(" "));
    const task = criarTask(message);

    if (pedido.tipo !== "reservar") {
      transitar(task, "TASK_STATE_FAILED", "Pedido invalido. Use: reservar sala=<id> inicio=<iso> fim=<iso> responsavel=<nome>");
      return ok(task);
    }

    const args: ArgumentosReserva = {
      sala: pedido.sala,
      inicio: pedido.inicio,
      fim: pedido.fim,
      responsavel: pedido.responsavel,
    };

    // Descoberta em runtime antes da primeira chamada, e nunca uma lista fixa.
    await this.host.descobrirTools(traceId);

    task.status = { state: "TASK_STATE_WORKING" };
    const res = await this.host.reservar(args, traceId);

    if (res.tipo === "erro") {
      transitar(task, "TASK_STATE_FAILED", res.mensagem);
      return ok(task);
    }
    if (res.tipo === "complete") {
      await this.concluir(task, res.structured, traceId);
      return ok(task);
    }

    // input_required: a ponte pausa a Task e guarda o requestState opaco.
    task.pausa = {
      requestState: res.requestState,
      chave: res.chave,
      alternativas: res.alternativas,
      argumentos: args,
      traceId,
    };
    transitar(task, "TASK_STATE_INPUT_REQUIRED", `alternativas: ${res.alternativas.join(", ")}`);
    return ok(task);
  }

  // --- Continuacao de uma Task pausada -----------------------------------

  private async continuar(message: Mensagem, traceId?: string): Promise<RespostaRpc> {
    const task = acharTask(message.taskId);
    if (!task) return falha(-32001, `Task nao encontrada: ${message.taskId}`);
    if (estadoTerminal(task)) {
      return falha(-32002, `Task em estado terminal (${task.status.state}) nao aceita novas mensagens`);
    }
    if (!task.pausa) return falha(-32002, "Task nao esta aguardando escolha");

    task.history.push(message);
    const pedido = interpretar(message.parts.map((p) => p.text).join(" "));
    const pausa = task.pausa;
    // O trace-id da continuacao propaga para os requests MCP desta Task.
    const trace = traceId ?? pausa.traceId;

    if (pedido.tipo !== "escolha") {
      transitar(task, "TASK_STATE_INPUT_REQUIRED", `alternativas: ${pausa.alternativas.join(", ")}`);
      return ok(task);
    }

    if (pedido.valor === "recusar") {
      task.status = { state: "TASK_STATE_WORKING" };
      // Recusa vira action=decline na elicitation; o retry ainda ecoa o requestState.
      await this.host.retomar(pausa.argumentos, pausa.chave, { action: "decline" }, pausa.requestState, trace);
      task.pausa = undefined;
      transitar(task, "TASK_STATE_CANCELED", "Reserva cancelada: alternativas recusadas.");
      return ok(task);
    }

    if (!pausa.alternativas.includes(pedido.valor)) {
      // Escolha fora do enum: mantem a Task pausada e repete as alternativas.
      transitar(task, "TASK_STATE_INPUT_REQUIRED", `alternativas: ${pausa.alternativas.join(", ")}`);
      return ok(task);
    }

    task.status = { state: "TASK_STATE_WORKING" };
    const res = await this.host.retomar(
      pausa.argumentos,
      pausa.chave,
      { action: "accept", content: { sala: pedido.valor } },
      pausa.requestState,
      trace,
    );

    if (res.tipo === "erro") {
      task.pausa = undefined;
      transitar(task, "TASK_STATE_FAILED", res.mensagem);
      return ok(task);
    }
    if (res.tipo === "complete") {
      task.pausa = undefined;
      await this.concluir(task, res.structured, trace);
      return ok(task);
    }
    // Inesperado: outro input_required. Mantem pausada.
    transitar(task, "TASK_STATE_INPUT_REQUIRED", `alternativas: ${res.alternativas.join(", ")}`);
    return ok(task);
  }

  // --- Conclusao com artifact --------------------------------------------

  private async concluir(task: Task, s: ReservaStructured, traceId?: string): Promise<void> {
    // A versao da politica vem do resource lido pelo agente, nao de um valor fixo.
    const politica = await this.host.politicaVersao(traceId);
    const conteudo = {
      reserva: s.reserva,
      sala: s.sala,
      inicio: s.inicio,
      fim: s.fim,
      responsavel: s.responsavel,
      politica,
    };
    task.artifacts.push({
      artifactId: novoArtifactId(),
      name: "reserva",
      parts: [{ text: JSON.stringify(conteudo) }],
    });
    transitar(task, "TASK_STATE_COMPLETED", `Reserva ${s.reserva} confirmada na ${s.sala}.`);
  }
}
