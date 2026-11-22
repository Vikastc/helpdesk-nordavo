// src/agent.ts — Pure functional orchestration loop for processing Helpdesk tickets.
// Connects classification, resilience, idempotency guards, and structured JSONL logging.

import * as client from "./client.js";
import { classifyTicket } from "./classifier.js";
import {
  loadState,
  isTicketHandled,
  recordTicketHandled,
} from "./state.js";
import { createLogger, type LoggerInstance } from "./logger.js";
import { AlreadyHandledError, type Classification, type Ticket } from "./types.js";

export interface AgentRunOptions {
  stateFile?: string;
  logDir?: string;
  onProgress?: (message: string) => void;
}

export interface AgentRunSummary {
  run_id: string;
  total_open: number;
  processed: number;
  replied: number;
  handed_off: number;
  closed: number;
  skipped: number;
  errors: number;
  log_file: string;
  duration_ms: number;
}

/**
 * Executes a single ticket action against the Helpdesk API.
 */
async function dispatchTicketAction(
  ticketId: string,
  decision: Classification
): Promise<void> {
  switch (decision.action) {
    case "reply":
      if (!decision.draft_reply) {
        throw new Error(`Cannot execute 'reply' on ${ticketId} without draft_reply`);
      }
      await client.replyTicket(ticketId, {
        language: decision.language,
        category: decision.category,
        priority: decision.priority,
        reason: decision.reason,
        draft_reply: decision.draft_reply,
        confidence: decision.confidence,
      });
      break;

    case "handoff":
      if (!decision.handoff_note) {
        throw new Error(`Cannot execute 'handoff' on ${ticketId} without handoff_note`);
      }
      await client.handoffTicket(ticketId, {
        language: decision.language,
        category: decision.category,
        priority: decision.priority,
        reason: decision.reason,
        handoff_note: decision.handoff_note,
        confidence: decision.confidence,
      });
      break;

    case "close":
      await client.closeTicket(ticketId, {
        language: decision.language,
        category: decision.category,
        priority: decision.priority,
        reason: decision.reason,
        confidence: decision.confidence,
      });
      break;
  }
}

/**
 * Autonomous agent run: fetches open tickets, classifies each, executes decisions,
 * enforces idempotency, and logs results to JSONL.
 */
export async function runAgent(
  options: AgentRunOptions = {}
): Promise<AgentRunSummary> {
  const startTime = Date.now();
  console.log("\n🐓 Roosterly Support Agent — Starting Autonomous Run\n");

  // 1. Check API Status
  const status = await client.getStatus();
  console.log(
    `📊 Helpdesk Status: mode=${status.mode}, open=${status.open_tickets}, handled=${status.handled_tickets}`
  );

  // 2. Load Local State (Crash Recovery Checkpoint)
  let state = loadState(options.stateFile);
  const alreadyHandledCount = Object.keys(state.handled_tickets).length;
  console.log(
    `💾 Checkpoint State: ${alreadyHandledCount} tickets previously recorded in state.json (Run ID: ${state.run_id})\n`
  );

  // 3. Initialize Structured JSONL Logger
  const logger: LoggerInstance = createLogger(state.run_id, options.logDir);
  console.log(`📝 Writing audit logs to ${logger.logFile}\n`);

  // 4. Fetch All Open Tickets
  console.log("📥 Fetching open tickets from Helpdesk API...");
  const tickets = await client.getAllOpenTickets();
  console.log(`   Found ${tickets.length} open tickets to process\n`);

  // 5. Orchestration Counters
  let replied = 0;
  let handedOff = 0;
  let closed = 0;
  let skipped = 0;
  let errors = 0;

  // 6. Process Each Ticket
  for (const ticket of tickets) {
    // ── Idempotency Check: Skip already handled tickets ──
    if (isTicketHandled(state, ticket.id)) {
      console.log(`⏭️  ${ticket.id}: Already handled locally, skipping`);
      skipped++;
      continue;
    }

    try {
      console.log(`\n── Processing Ticket ${ticket.id} ────────────────────────`);
      console.log(`   Subject: "${ticket.subject}"`);
      console.log(`   Plan: ${ticket.customer_plan} | Channel: ${ticket.channel}`);

      // Step A: Classify with LLM & Guardrails
      console.log("   🤖 Classifying with Claude & Guardrails...");
      const decision = await classifyTicket(ticket);
      console.log(
        `   → Decision: [${decision.action.toUpperCase()}] Category: ${decision.category} | Priority: ${decision.priority} | Lang: ${decision.language}`
      );
      console.log(`   → Reason: ${decision.reason}`);
      if (decision.verification) {
        console.log(
          `   🔍 Grounding Check: grounded=${decision.verification.grounded} | Back-translation: "${decision.verification.back_translation}"`
        );
      }

      // Step B: Dispatch Action to Helpdesk API
      console.log(`   🚀 Dispatching ${decision.action} to Helpdesk API...`);
      await dispatchTicketAction(ticket.id, decision);

      // Step C: Record in Local State Checkpoint
      state = recordTicketHandled(
        state,
        ticket.id,
        decision.action,
        options.stateFile
      );

      // Step D: Write Structured Log Line
      logger.logTicket({
        timestamp: new Date().toISOString(),
        ticket_id: ticket.id,
        channel: ticket.channel,
        customer_plan: ticket.customer_plan,
        action: decision.action,
        language: decision.language,
        category: decision.category,
        priority: decision.priority,
        reason: decision.reason,
        confidence: decision.confidence,
        success: true,
        verification: decision.verification
          ? {
              back_translation: decision.verification.back_translation,
              grounded: decision.verification.grounded,
              unsupported_claims: decision.verification.unsupported_claims,
            }
          : undefined,
      });

      // Update counters
      switch (decision.action) {
        case "reply":
          replied++;
          break;
        case "handoff":
          handedOff++;
          break;
        case "close":
          closed++;
          break;
      }

      console.log(`   ✅ ${ticket.id}: Successfully handled with ${decision.action}`);
    } catch (err) {
      if (err instanceof AlreadyHandledError) {
        console.warn(`   ⚠️  ${ticket.id}: Helpdesk reported already handled (409), recording in state`);
        state = recordTicketHandled(
          state,
          ticket.id,
          "already_handled_409",
          options.stateFile
        );
        skipped++;
      } else {
        console.error(`   ❌ ${ticket.id}: Failed to process — ${err}`);
        errors++;

        logger.logTicket({
          timestamp: new Date().toISOString(),
          ticket_id: ticket.id,
          channel: ticket.channel,
          customer_plan: ticket.customer_plan,
          action: "error",
          reason: "Processing error encountered",
          success: false,
          error: (err as Error).message ?? String(err),
        });
      }
    }
  }

  // 7. Cleanup & Summary
  logger.close();
  const durationMs = Date.now() - startTime;
  const processed = replied + handedOff + closed;

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("🐓 Autonomous Run Complete!");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`   ✉️  Replied:     ${replied}`);
  console.log(`   🤝 Handed Off:  ${handedOff}`);
  console.log(`   🗑️  Closed:      ${closed}`);
  console.log(`   ⏭️  Skipped:     ${skipped}`);
  console.log(`   ❌ Errors:      ${errors}`);
  console.log(`   📊 Total Open:  ${tickets.length}`);
  console.log(`   ⏱️  Duration:    ${(durationMs / 1000).toFixed(2)}s`);
  console.log(`   📝 Log File:    ${logger.logFile}`);
  console.log("══════════════════════════════════════════════════════════════\n");

  return {
    run_id: state.run_id,
    total_open: tickets.length,
    processed,
    replied,
    handed_off: handedOff,
    closed,
    skipped,
    errors,
    log_file: logger.logFile,
    duration_ms: durationMs,
  };
}
