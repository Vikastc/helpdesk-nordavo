// src/types.ts — Shared type definitions.

import { z } from "zod";

// ─── API responses ────────────────────────────────────────────────

export interface TicketHandledInfo {
  action: string;
  at: string;
}

export interface Ticket {
  id: string;
  received_at: string;
  channel: string;
  customer_plan: string;
  subject: string;
  body: string;
  status?: string;
  handled?: TicketHandledInfo | null;
}

export interface TicketsPage {
  tickets: Ticket[];
  next_cursor: string | null;
}

export interface HelpdeskStatus {
  mode: string;
  candidate: string;
  open_tickets: number;
  handled_tickets: number;
  live_ends_at: string | null;
}

export interface LabelledExample {
  id: string;
  subject: string;
  body: string;
  channel?: string;
  customer_plan?: string;
  label: {
    language: string;
    category: string;
    priority: string;
    action: string;
    reason: string;
  };
}

export interface ExamplesResponse {
  examples: LabelledExample[];
}

// ─── Action Request & Response Types ──────────────────────────────

export interface ReplyPayload {
  language: "nl" | "en" | "de";
  category: "bug" | "billing" | "feature_request" | "question" | "other";
  priority: "P1" | "P2" | "P3" | "P4";
  reason: string;
  draft_reply: string;
  confidence?: number;
}

export interface HandoffPayload {
  language: "nl" | "en" | "de";
  category: "bug" | "billing" | "feature_request" | "question" | "other";
  priority: "P1" | "P2" | "P3" | "P4";
  reason: string;
  handoff_note: string;
  confidence?: number;
}

export interface ClosePayload {
  language: "nl" | "en" | "de";
  category: "bug" | "billing" | "feature_request" | "question" | "other";
  priority: "P1" | "P2" | "P3" | "P4";
  reason: string;
  confidence?: number;
}

export interface ActionResponse {
  ok: boolean;
  action: "reply" | "handoff" | "close";
  ticket_id: string;
}

// ─── Agent State ──────────────────────────────────────────────────

export interface HandledTicketRecord {
  action: string;
  timestamp: string;
}

export interface AgentState {
  run_id: string;
  handled_tickets: Record<string, HandledTicketRecord>;
}

// ─── Custom Errors ────────────────────────────────────────────────

export class AlreadyHandledError extends Error {
  constructor(public readonly ticketId: string) {
    super(`Ticket ${ticketId} was already handled (409)`);
    this.name = "AlreadyHandledError";
  }
}

export class HelpdeskApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly details: unknown
  ) {
    super(`Helpdesk API error ${status} (${code}): ${JSON.stringify(details)}`);
    this.name = "HelpdeskApiError";
  }
}

// ─── Classification (agent output per ticket) ─────────────────────

/** Schema for OpenAI Structured Outputs (all fields required, nullable for optional) */
export const LlmClassificationSchema = z.object({
  language: z.enum(["nl", "en", "de"]),
  category: z.enum(["bug", "billing", "feature_request", "question", "other"]),
  priority: z.enum(["P1", "P2", "P3", "P4"]),
  action: z.enum(["reply", "handoff", "close"]),
  reason: z.string(),
  draft_reply: z.string().nullable(),
  handoff_note: z.string().nullable(),
  confidence: z.number().nullable(),
});

export type LlmClassification = z.infer<typeof LlmClassificationSchema>;

export const ClassificationSchema = z.object({
  language: z.enum(["nl", "en", "de"]),
  category: z.enum(["bug", "billing", "feature_request", "question", "other"]),
  priority: z.enum(["P1", "P2", "P3", "P4"]),
  action: z.enum(["reply", "handoff", "close"]),
  reason: z.string().min(1),
  draft_reply: z.string().optional(),
  handoff_note: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export type Classification = z.infer<typeof ClassificationSchema>;
