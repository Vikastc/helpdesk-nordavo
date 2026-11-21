// src/types.ts — Shared type definitions.

import { z } from "zod";

// ─── API responses ────────────────────────────────────────────────

export interface Ticket {
  id: string;
  received_at: string;
  channel: string;
  customer_plan: string;
  subject: string;
  body: string;
  status?: string;
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

// ─── Classification (agent output per ticket) ─────────────────────

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
