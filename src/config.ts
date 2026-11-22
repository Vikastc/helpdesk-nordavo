// src/config.ts — Load and validate environment variables.

import "dotenv/config";

export const config = {
  helpdesk: {
    baseUrl: "https://nakywgkztvzkihdjnwbc.supabase.co/functions/v1/helpdesk",
    apiKey: process.env.HELPDESK_API_KEY ?? "",
    candidateEmail: process.env.CANDIDATE_EMAIL ?? "",
  },
  llm: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.LLM_API_KEY ?? "",
    model: process.env.LLM_MODEL ?? "claude-haiku-5-5",
    baseUrl: process.env.LLM_BASE_URL ?? "https://api.anthropic.com/v1/",
  },
} as const;

export function validateHelpdeskConfig(): void {
  if (!config.helpdesk.apiKey) throw new Error("HELPDESK_API_KEY is required");
  if (!config.helpdesk.candidateEmail)
    throw new Error("CANDIDATE_EMAIL is required");
}

export function validateFullConfig(): void {
  validateHelpdeskConfig();
  if (!config.llm.apiKey)
    throw new Error("ANTHROPIC_API_KEY (or LLM_API_KEY) is required");
}
