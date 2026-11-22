// src/logger.ts — Structured JSONL logging for agent runs.
// Guarantees one log line per ticket in logs/, with all PII (IBANs/cards) stripped.

import * as fs from "node:fs";
import * as path from "node:path";
import { stripPII } from "./guardrails.js";

const DEFAULT_LOG_DIR = path.resolve("logs");

export interface TicketLogEntry {
  timestamp: string;
  ticket_id: string;
  channel?: string;
  customer_plan?: string;
  action: "reply" | "handoff" | "close" | "error" | "skipped";
  language?: string;
  category?: string;
  priority?: string;
  reason: string;
  confidence?: number;
  success: boolean;
  error?: string;
  verification?: {
    back_translation: string;
    grounded: boolean;
    unsupported_claims?: string[];
  };
}

export interface LoggerInstance {
  logFile: string;
  logTicket: (entry: TicketLogEntry) => void;
  close: () => void;
}

/**
 * Creates a functional JSONL logger instance tied to a run ID.
 */
export function createLogger(
  runId: string,
  logDir = DEFAULT_LOG_DIR
): LoggerInstance {
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const shortId = runId.slice(0, 8);
  const logFile = path.join(logDir, `run_${timestamp}_${shortId}.jsonl`);
  const stream = fs.createWriteStream(logFile, { flags: "a", encoding: "utf-8" });

  const logTicket = (entry: TicketLogEntry): void => {
    // Strictly strip all payment details from all logged fields
    const sanitized: TicketLogEntry = {
      ...entry,
      reason: stripPII(entry.reason),
      error: entry.error ? stripPII(entry.error) : undefined,
      verification: entry.verification
        ? {
            ...entry.verification,
            back_translation: stripPII(entry.verification.back_translation),
          }
        : undefined,
    };
    stream.write(JSON.stringify(sanitized) + "\n");
  };

  const close = (): void => {
    stream.end();
  };

  return {
    logFile,
    logTicket,
    close,
  };
}
