// src/client.ts — Resilient, functional Helpdesk API client.
// Handles rate limits (429), transient service errors (503) with backoff & jitter,
// and enforces single-action idempotency (409).

import { config } from "./config.js";
import {
  AlreadyHandledError,
  HelpdeskApiError,
  type Ticket,
  type TicketsPage,
  type HelpdeskStatus,
  type LabelledExample,
  type ExamplesResponse,
  type ReplyPayload,
  type HandoffPayload,
  type ClosePayload,
  type ActionResponse,
} from "./types.js";

// ─── Helpers ──────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const headers = (): Record<string, string> => ({
  Authorization: `Bearer ${config.helpdesk.apiKey}`,
  "X-Candidate-Email": config.helpdesk.candidateEmail,
  "Content-Type": "application/json",
});

const getUrl = (path: string): string => `${config.helpdesk.baseUrl}${path}`;

// ─── Self-Throttling (Rate Limiter) ────────────────────────────────

const createThrottler = (minIntervalMs: number) => {
  let lastRequestTime = 0;

  return async (): Promise<void> => {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < minIntervalMs) {
      await sleep(minIntervalMs - elapsed);
    }
    lastRequestTime = Date.now();
  };
};

// Target ~4 requests/second (safely below the 5 req/s limit)
const throttle = createThrottler(250);

// ─── Exponential Backoff with Jitter ──────────────────────────────

const calculateBackoff = (
  attempt: number,
  baseMs = 500,
  maxMs = 8000
): number => {
  const exponential = Math.min(baseMs * 2 ** (attempt - 1), maxMs);
  const jitter = Math.random() * 200;
  return exponential + jitter;
};

// ─── Core Resilient Request Handler ───────────────────────────────

export interface RequestOptions {
  maxRetries?: number;
  log?: (message: string) => void;
}

export async function requestWithResilience<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  options: RequestOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 5;
  const log = options.log ?? console.warn;
  let attempt = 0;

  while (true) {
    await throttle();
    attempt++;

    try {
      const res = await fetch(getUrl(path), {
        method,
        headers: headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      // ── 2xx Success ──
      if (res.ok) {
        return (await res.json()) as T;
      }

      // Parse error payload if available
      const errorJson = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const errorCode = (errorJson.error as string) ?? "unknown_error";

      // ── 429 Rate Limited ──
      if (res.status === 429) {
        const retryAfterSec = parseInt(
          res.headers.get("Retry-After") ?? "2",
          10
        );
        const waitMs = Math.max(retryAfterSec * 1000, 1000);
        log(`⏳ 429 Rate limited on ${path}. Waiting ${waitMs}ms before retry (attempt ${attempt})`);
        await sleep(waitMs);
        continue;
      }

      // ── 503 Service Unavailable (Simulated Flakiness ~5%) ──
      if (res.status === 503) {
        if (attempt >= maxRetries) {
          throw new HelpdeskApiError(
            503,
            "service_unavailable",
            `Max retries (${maxRetries}) exceeded for ${path}`
          );
        }
        const backoffMs = calculateBackoff(attempt);
        log(
          `🔄 503 Service unavailable on ${path}. Retrying in ${Math.round(backoffMs)}ms (attempt ${attempt}/${maxRetries})`
        );
        await sleep(backoffMs);
        continue;
      }

      // ── 409 Already Handled ──
      if (res.status === 409) {
        const ticketIdMatch = path.match(/\/tickets\/([^/]+)/);
        const ticketId = ticketIdMatch ? ticketIdMatch[1] : "unknown";
        throw new AlreadyHandledError(ticketId);
      }

      // ── Client / Validation Errors (400, 401, 404, 422) ──
      throw new HelpdeskApiError(res.status, errorCode, errorJson);
    } catch (err) {
      // Re-throw our typed errors without retrying
      if (
        err instanceof AlreadyHandledError ||
        (err instanceof HelpdeskApiError && err.status !== 503)
      ) {
        throw err;
      }

      // Transient network failure (socket error / fetch failed)
      if (attempt < maxRetries) {
        const backoffMs = calculateBackoff(attempt);
        log(
          `⚠️ Network failure (${(err as Error).message}) on ${path}. Retrying in ${Math.round(backoffMs)}ms (attempt ${attempt}/${maxRetries})`
        );
        await sleep(backoffMs);
        continue;
      }

      throw err;
    }
  }
}

// ─── Public Functional API ────────────────────────────────────────

export const getStatus = (options?: RequestOptions): Promise<HelpdeskStatus> =>
  requestWithResilience<HelpdeskStatus>("GET", "/status", undefined, options);

export const getExamples = async (
  options?: RequestOptions
): Promise<LabelledExample[]> => {
  const res = await requestWithResilience<ExamplesResponse>(
    "GET",
    "/examples",
    undefined,
    options
  );
  return res.examples;
};

export const getTicketsPage = (
  limit = 10,
  cursor?: string,
  status: "open" | "all" = "open",
  options?: RequestOptions
): Promise<TicketsPage> => {
  let path = `/tickets?limit=${limit}&status=${status}`;
  if (cursor) path += `&cursor=${cursor}`;
  return requestWithResilience<TicketsPage>("GET", path, undefined, options);
};

export const getTicket = (
  id: string,
  options?: RequestOptions
): Promise<Ticket> =>
  requestWithResilience<Ticket>("GET", `/tickets/${id}`, undefined, options);

export async function getAllOpenTickets(
  options?: RequestOptions
): Promise<Ticket[]> {
  const all: Ticket[] = [];
  let cursor: string | undefined;

  do {
    const page = await getTicketsPage(10, cursor, "open", options);
    all.push(...page.tickets);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);

  return all;
}

export const replyTicket = (
  id: string,
  payload: ReplyPayload,
  options?: RequestOptions
): Promise<ActionResponse> =>
  requestWithResilience<ActionResponse>(
    "POST",
    `/tickets/${id}/reply`,
    payload,
    options
  );

export const handoffTicket = (
  id: string,
  payload: HandoffPayload,
  options?: RequestOptions
): Promise<ActionResponse> =>
  requestWithResilience<ActionResponse>(
    "POST",
    `/tickets/${id}/handoff`,
    payload,
    options
  );

export const closeTicket = (
  id: string,
  payload: ClosePayload,
  options?: RequestOptions
): Promise<ActionResponse> =>
  requestWithResilience<ActionResponse>(
    "POST",
    `/tickets/${id}/close`,
    payload,
    options
  );

export const resetPractice = (
  options?: RequestOptions
): Promise<{ ok: boolean; reopened_tickets: number }> =>
  requestWithResilience<{ ok: boolean; reopened_tickets: number }>(
    "POST",
    "/practice/reset",
    undefined,
    options
  );
