// src/client.ts — Thin, functional wrapper around the helpdesk API.
// No retry logic yet — that comes in Phase 2.

import { config } from "./config.js";
import type {
  Ticket,
  TicketsPage,
  HelpdeskStatus,
  LabelledExample,
  ExamplesResponse,
} from "./types.js";

// ─── Helpers ──────────────────────────────────────────────────────

const headers = (): Record<string, string> => ({
  Authorization: `Bearer ${config.helpdesk.apiKey}`,
  "X-Candidate-Email": config.helpdesk.candidateEmail,
  "Content-Type": "application/json",
});

const url = (path: string): string => `${config.helpdesk.baseUrl}${path}`;

async function get<T>(path: string): Promise<T> {
  const res = await fetch(url(path), { headers: headers() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET ${path} failed (${res.status}): ${body}`);
  }
  return (await res.json()) as T;
}

// ─── Public API ───────────────────────────────────────────────────

export const getStatus = (): Promise<HelpdeskStatus> =>
  get<HelpdeskStatus>("/status");

export const getExamples = async (): Promise<LabelledExample[]> => {
  const res = await get<ExamplesResponse>("/examples");
  return res.examples;
};

export const getTicketsPage = (
  limit = 10,
  cursor?: string,
  status: "open" | "all" = "open"
): Promise<TicketsPage> => {
  let path = `/tickets?limit=${limit}&status=${status}`;
  if (cursor) path += `&cursor=${cursor}`;
  return get<TicketsPage>(path);
};

export const getTicket = (id: string): Promise<Ticket> =>
  get<Ticket>(`/tickets/${id}`);

export async function getAllOpenTickets(): Promise<Ticket[]> {
  const all: Ticket[] = [];
  let cursor: string | undefined;

  do {
    const page = await getTicketsPage(10, cursor, "open");
    all.push(...page.tickets);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);

  return all;
}

export async function resetPractice(): Promise<void> {
  const res = await fetch(url("/practice/reset"), {
    method: "POST",
    headers: headers(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`POST /practice/reset failed (${res.status}): ${body}`);
  }
}
