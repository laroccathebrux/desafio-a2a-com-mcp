/**
 * Dominio da Central de Salas: dados, politica e regras de negocio.
 *
 * Toda a decisao de dominio (conflito, politica, alternativas) vive AQUI, no
 * servidor MCP. O agente A2A nao reimplementa nada disto: ele so traduz protocolo.
 *
 * Os dados chegam prontos em ../dados (fora de servidor-mcp/, na raiz do repo) e
 * nao podem ser alterados. As reservas ficam em memoria: as criadas durante a
 * execucao sao visiveis para as consultas seguintes do mesmo processo, e nao
 * sobrevivem a um restart (isso e proposital; o estado que precisa sobreviver a
 * um restart viaja no requestState, nao aqui).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ_DADOS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "dados");

export interface Sala {
  id: string;
  nome: string;
  capacidade: number;
  recursos: string[];
}

export interface Reserva {
  id: string;
  sala: string;
  inicio: string;
  fim: string;
  responsavel: string;
}

// Mensagens de erro de execucao: fonte unica de verdade, o validador exige o
// texto exato dentro do resultado.
export const ERRO_SALA = (id: string) => `Sala inexistente: ${id}`;
export const ERRO_JANELA = "Fora da janela de uso: a politica permite reservas entre 08:00 e 20:00";
export const ERRO_DURACAO = "Duracao acima do limite: a politica permite no maximo 2 horas";
export const ERRO_INTERVALO = "Intervalo invalido: fim deve ser posterior a inicio";
export const ERRO_SEM_ALTERNATIVA = "Sem alternativas disponiveis no intervalo";

const JANELA_INICIO_MIN = 8 * 60; // 08:00
const JANELA_FIM_MIN = 20 * 60; // 20:00
const DURACAO_MAX_MS = 2 * 60 * 60 * 1000; // 2 horas
const FUSO_SAO_PAULO_MS = 3 * 60 * 60 * 1000; // -03:00 fixo, como manda a politica

// --- Estado ---------------------------------------------------------------

const SALAS: Sala[] = JSON.parse(readFileSync(resolve(RAIZ_DADOS, "salas.json"), "utf8"));
const RESERVAS: Reserva[] = JSON.parse(readFileSync(resolve(RAIZ_DADOS, "reservas.json"), "utf8"));
const POLITICA_TEXTO = readFileSync(resolve(RAIZ_DADOS, "politica-de-uso.md"), "utf8");
export const POLITICA_VERSAO = (POLITICA_TEXTO.match(/versao:\s*(\S+)/)?.[1] ?? "").trim();

let proximoId = RESERVAS.length + 1;
function novoIdReserva(): string {
  return `res-${String(proximoId++).padStart(4, "0")}`;
}

export function listarSalas(): Sala[] {
  return SALAS.map((s) => ({ ...s, recursos: [...s.recursos] }));
}

export function politicaTexto(): string {
  return POLITICA_TEXTO;
}

function acharSala(id: string): Sala | undefined {
  return SALAS.find((s) => s.id === id);
}

// --- Tempo ----------------------------------------------------------------

function epoch(iso: string): number {
  return new Date(iso).getTime();
}

/** Minutos desde meia-noite no horario de Sao Paulo (-03:00 fixo). */
function minutosDoDia(iso: string): number {
  const parede = new Date(epoch(iso) - FUSO_SAO_PAULO_MS);
  return parede.getUTCHours() * 60 + parede.getUTCMinutes();
}

// --- Validacao da politica ------------------------------------------------

export interface ErroDominio {
  mensagem: string;
}

/**
 * Valida sala + politica na ordem que o validador cobra, cada erro isolado:
 * sala inexistente, intervalo invertido, janela de uso, duracao maxima.
 */
export function validar(sala: string, inicio: string, fim: string): ErroDominio | null {
  if (!acharSala(sala)) return { mensagem: ERRO_SALA(sala) };

  const i = epoch(inicio);
  const f = epoch(fim);
  if (Number.isNaN(i) || Number.isNaN(f) || f <= i) return { mensagem: ERRO_INTERVALO };

  if (minutosDoDia(inicio) < JANELA_INICIO_MIN || minutosDoDia(fim) > JANELA_FIM_MIN) {
    return { mensagem: ERRO_JANELA };
  }

  if (f - i > DURACAO_MAX_MS) return { mensagem: ERRO_DURACAO };

  return null;
}

// --- Conflitos e alternativas ---------------------------------------------

function sobrepoe(aInicio: string, aFim: string, bInicio: string, bFim: string): boolean {
  return epoch(aInicio) < epoch(bFim) && epoch(bInicio) < epoch(aFim);
}

export function conflitosDe(sala: string, inicio: string, fim: string): Reserva[] {
  return RESERVAS.filter((r) => r.sala === sala && sobrepoe(inicio, fim, r.inicio, r.fim));
}

function salaLivre(sala: string, inicio: string, fim: string): boolean {
  return conflitosDe(sala, inicio, fim).length === 0;
}

/**
 * Salas livres no intervalo com capacidade >= a da sala pedida, no maximo tres,
 * ordenadas por capacidade crescente e, em empate, por id alfabetico.
 */
export function alternativas(salaPedida: string, inicio: string, fim: string): string[] {
  const pedida = acharSala(salaPedida);
  const capacidadeMinima = pedida?.capacidade ?? 0;
  return SALAS.filter(
    (s) =>
      s.id !== salaPedida &&
      s.capacidade >= capacidadeMinima &&
      salaLivre(s.id, inicio, fim),
  )
    .sort((a, b) => a.capacidade - b.capacidade || a.id.localeCompare(b.id))
    .slice(0, 3)
    .map((s) => s.id);
}

// --- Disponibilidade e reserva --------------------------------------------

export interface Disponibilidade {
  sala: string;
  livre: boolean;
  conflitos: { id: string; inicio: string; fim: string; responsavel: string }[];
}

export function consultarDisponibilidade(
  sala: string,
  inicio: string,
  fim: string,
): { erro: ErroDominio } | { disponibilidade: Disponibilidade } {
  const erro = validar(sala, inicio, fim);
  if (erro) return { erro };
  const conflitos = conflitosDe(sala, inicio, fim).map((r) => ({
    id: r.id,
    inicio: r.inicio,
    fim: r.fim,
    responsavel: r.responsavel,
  }));
  return { disponibilidade: { sala, livre: conflitos.length === 0, conflitos } };
}

export interface ReservaCriada {
  reserva: string;
  reservado: true;
  sala: string;
  inicio: string;
  fim: string;
  responsavel: string;
  politica: string;
  motivo: null;
}

/** Cria de fato a reserva em memoria e devolve o registro completo. */
export function criarReserva(
  sala: string,
  inicio: string,
  fim: string,
  responsavel: string,
): ReservaCriada {
  const reserva: Reserva = { id: novoIdReserva(), sala, inicio, fim, responsavel };
  RESERVAS.push(reserva);
  return {
    reserva: reserva.id,
    reservado: true,
    sala,
    inicio,
    fim,
    responsavel,
    politica: POLITICA_VERSAO,
    motivo: null,
  };
}
