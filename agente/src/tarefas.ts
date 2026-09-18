/**
 * Task A2A: identidade, estado e produto. Aqui vive a maquina de estados e o
 * armazenamento em memoria das Tasks.
 *
 * A "ponte" tem seu ponto de guarda aqui: cada Task pausada carrega uma gaveta
 * `pausa` com o requestState opaco devolvido pelo servidor MCP, a chave do
 * inputRequests e o enum de alternativas. Esse requestState NUNCA e exposto em
 * nenhuma resposta A2A (card, artifact ou mensagem) — ele so volta para o
 * servidor MCP no retry.
 */
import { randomBytes } from "node:crypto";

export type EstadoTask =
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_INPUT_REQUIRED"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_FAILED";

export interface Parte {
  text: string;
}

export interface Mensagem {
  messageId: string;
  role: "ROLE_USER" | "ROLE_AGENT";
  parts: Parte[];
  taskId?: string;
  contextId?: string;
}

export interface Artifact {
  artifactId: string;
  name: string;
  parts: Parte[];
}

export interface StatusTask {
  state: EstadoTask;
  message?: Mensagem;
}

/** Estado da ponte guardado por Task enquanto ela esta pausada. Interno. */
export interface Pausa {
  requestState: string;
  chave: string; // a mesma chave que veio no inputRequests do servidor MCP
  alternativas: string[]; // enum, na ordem em que o servidor devolveu
  argumentos: { sala: string; inicio: string; fim: string; responsavel: string };
  traceId?: string; // trace-id da chamada A2A que abriu a pausa
}

export interface Task {
  id: string;
  contextId: string;
  status: StatusTask;
  history: Mensagem[];
  artifacts: Artifact[];
  pausa?: Pausa; // NUNCA serializado nas respostas
}

const ESTADOS_TERMINAIS: ReadonlySet<EstadoTask> = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_FAILED",
]);

export function estadoTerminal(t: Task): boolean {
  return ESTADOS_TERMINAIS.has(t.status.state);
}

const id = (prefixo: string) => `${prefixo}-${randomBytes(6).toString("hex")}`;
export const novoTaskId = () => id("task");
export const novoContextId = () => id("ctx");
export const novoMessageId = () => id("msg");
export const novoArtifactId = () => id("art");

const TAREFAS = new Map<string, Task>();

export function criarTask(mensagemUsuario: Mensagem): Task {
  const task: Task = {
    id: novoTaskId(),
    contextId: novoContextId(),
    status: { state: "TASK_STATE_SUBMITTED" },
    history: [mensagemUsuario],
    artifacts: [],
  };
  TAREFAS.set(task.id, task);
  return task;
}

export function acharTask(id: string | undefined): Task | undefined {
  return id ? TAREFAS.get(id) : undefined;
}

export function mensagemAgente(task: Task, texto: string): Mensagem {
  return {
    messageId: novoMessageId(),
    role: "ROLE_AGENT",
    parts: [{ text: texto }],
    taskId: task.id,
    contextId: task.contextId,
  };
}

/** Muda o estado e registra a mensagem do agente no historico e no status. */
export function transitar(task: Task, estado: EstadoTask, texto: string): void {
  const msg = mensagemAgente(task, texto);
  task.status = { state: estado, message: msg };
  task.history.push(msg);
}

/** Projecao publica da Task: sem a gaveta `pausa`. */
export function serializar(task: Task): Omit<Task, "pausa"> {
  return {
    id: task.id,
    contextId: task.contextId,
    status: task.status,
    history: task.history,
    artifacts: task.artifacts,
  };
}
