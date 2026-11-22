// tests/orchestration.test.ts — Unit tests for structured JSONL logging and orchestration behaviors.

import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger, type TicketLogEntry } from "../src/logger.js";
import {
  createInitialState,
  loadState,
  isTicketHandled,
  recordTicketHandled,
} from "../src/state.js";

const TEST_DIR = path.resolve("tests/temp_orch");
const TEST_LOG_DIR = path.join(TEST_DIR, "logs");
const TEST_STATE_FILE = path.join(TEST_DIR, "state.json");

describe("Structured JSONL Logging (src/logger.ts)", () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
  });

  it("writes valid JSONL with exactly one line per ticket", async () => {
    const logger = createLogger("test_run_1", TEST_LOG_DIR);

    const entry1: TicketLogEntry = {
      timestamp: new Date().toISOString(),
      ticket_id: "T001",
      channel: "email",
      customer_plan: "Basis",
      action: "reply",
      language: "nl",
      category: "question",
      priority: "P4",
      reason: "Answered via FAQ F01",
      confidence: 0.95,
      success: true,
    };

    const entry2: TicketLogEntry = {
      timestamp: new Date().toISOString(),
      ticket_id: "T002",
      channel: "form",
      customer_plan: "Plus",
      action: "handoff",
      language: "nl",
      category: "billing",
      priority: "P2",
      reason: "Escalated for refund",
      confidence: 0.9,
      success: true,
    };

    logger.logTicket(entry1);
    logger.logTicket(entry2);
    logger.close();

    // Small delay for stream flush
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(fs.existsSync(logger.logFile));
    const content = fs.readFileSync(logger.logFile, "utf-8").trim();
    const lines = content.split("\n");

    assert.equal(lines.length, 2);
    const parsed1 = JSON.parse(lines[0]);
    assert.equal(parsed1.ticket_id, "T001");
    assert.equal(parsed1.action, "reply");

    const parsed2 = JSON.parse(lines[1]);
    assert.equal(parsed2.ticket_id, "T002");
    assert.equal(parsed2.action, "handoff");
  });

  it("strictly scrubs IBANs and payment card numbers from log lines", async () => {
    const logger = createLogger("test_run_pii", TEST_LOG_DIR);

    logger.logTicket({
      timestamp: new Date().toISOString(),
      ticket_id: "T003",
      action: "handoff",
      reason: "Customer with account NL91ABNA0417164300 used card 4532-1234-5678-9012 for payment",
      success: true,
      error: "Refund to NL91ABNA0417164300 failed",
    });
    logger.close();

    await new Promise((r) => setTimeout(r, 50));

    const content = fs.readFileSync(logger.logFile, "utf-8").trim();
    assert.doesNotMatch(content, /NL91ABNA0417164300/);
    assert.doesNotMatch(content, /4532-1234-5678-9012/);
    assert.match(content, /\[IBAN REDACTED\]/);
    assert.match(content, /\[CARD REDACTED\]/);
  });
});

describe("Orchestration State Tracking & Idempotency", () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
  });

  it("skips tickets already recorded in state file", () => {
    let state = createInitialState("run_skip_test");
    state = recordTicketHandled(state, "T001", "reply", TEST_STATE_FILE);

    assert.equal(isTicketHandled(state, "T001"), true);
    assert.equal(isTicketHandled(state, "T002"), false);

    // Simulate reloading state
    const reloaded = loadState(TEST_STATE_FILE);
    assert.equal(isTicketHandled(reloaded, "T001"), true);
    assert.equal(isTicketHandled(reloaded, "T002"), false);
  });
});
