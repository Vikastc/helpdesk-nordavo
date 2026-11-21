// tests/resilience.test.ts — Unit tests for state persistence and client resilience.

import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createInitialState,
  loadState,
  saveState,
  isTicketHandled,
  recordTicketHandled,
  resetLocalState,
} from "../src/state.js";
import {
  AlreadyHandledError,
  HelpdeskApiError,
} from "../src/types.js";
import { requestWithResilience } from "../src/client.js";

const TEST_STATE_DIR = path.resolve("tests/temp");
const TEST_STATE_FILE = path.join(TEST_STATE_DIR, "test_state.json");

describe("State Management & Idempotency", () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_STATE_DIR)) {
      fs.rmSync(TEST_STATE_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(TEST_STATE_DIR)) {
      fs.rmSync(TEST_STATE_DIR, { recursive: true });
    }
  });

  it("initializes a fresh state when file does not exist", () => {
    const state = loadState(TEST_STATE_FILE);
    assert.ok(state.run_id);
    assert.deepEqual(state.handled_tickets, {});
  });

  it("records handled tickets and persists to disk", () => {
    let state = loadState(TEST_STATE_FILE);
    assert.equal(isTicketHandled(state, "T001"), false);

    state = recordTicketHandled(state, "T001", "reply", TEST_STATE_FILE);
    assert.equal(isTicketHandled(state, "T001"), true);
    assert.equal(state.handled_tickets["T001"].action, "reply");

    // Load fresh from disk
    const loaded = loadState(TEST_STATE_FILE);
    assert.equal(isTicketHandled(loaded, "T001"), true);
    assert.equal(loaded.handled_tickets["T001"].action, "reply");
  });

  it("prevents double-answering on re-run (crash recovery)", () => {
    let state = loadState(TEST_STATE_FILE);
    state = recordTicketHandled(state, "T001", "reply", TEST_STATE_FILE);
    state = recordTicketHandled(state, "T002", "handoff", TEST_STATE_FILE);

    // Simulating process restart:
    const resumedState = loadState(TEST_STATE_FILE);
    assert.equal(isTicketHandled(resumedState, "T001"), true);
    assert.equal(isTicketHandled(resumedState, "T002"), true);
    assert.equal(isTicketHandled(resumedState, "T003"), false);
  });

  it("resets state completely on resetLocalState", () => {
    let state = loadState(TEST_STATE_FILE);
    state = recordTicketHandled(state, "T001", "reply", TEST_STATE_FILE);

    const reset = resetLocalState(TEST_STATE_FILE);
    assert.deepEqual(reset.handled_tickets, {});

    const loaded = loadState(TEST_STATE_FILE);
    assert.deepEqual(loaded.handled_tickets, {});
  });
});

describe("Error Types", () => {
  it("creates AlreadyHandledError with ticket ID", () => {
    const err = new AlreadyHandledError("T005");
    assert.equal(err.name, "AlreadyHandledError");
    assert.equal(err.ticketId, "T005");
    assert.match(err.message, /T005/);
  });

  it("creates HelpdeskApiError with status code and details", () => {
    const err = new HelpdeskApiError(422, "validation_failed", {
      problems: ["missing draft_reply"],
    });
    assert.equal(err.name, "HelpdeskApiError");
    assert.equal(err.status, 422);
    assert.equal(err.code, "validation_failed");
    assert.match(err.message, /missing draft_reply/);
  });
});

describe("Client Resilience via Mocked Fetch", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("retries on 503 Service Unavailable and returns success on recovery", async () => {
    let calls = 0;
    const logs: string[] = [];

    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: "service_unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, attempt: calls }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const res = await requestWithResilience<{ ok: boolean; attempt: number }>(
      "GET",
      "/status",
      undefined,
      {
        maxRetries: 3,
        log: (msg) => logs.push(msg),
      }
    );

    assert.equal(calls, 2);
    assert.equal(res.ok, true);
    assert.equal(res.attempt, 2);
    assert.ok(logs.some((l) => l.includes("503 Service unavailable")));
  });

  it("throws AlreadyHandledError on 409 without retrying", async () => {
    let calls = 0;

    globalThis.fetch = async () => {
      calls++;
      return new Response(
        JSON.stringify({ error: "already_handled", message: "handled" }),
        {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }
      );
    };

    await assert.rejects(
      async () => {
        await requestWithResilience("POST", "/tickets/T001/reply", {
          language: "nl",
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AlreadyHandledError);
        assert.equal(err.ticketId, "T001");
        return true;
      }
    );

    // 409 must never retry
    assert.equal(calls, 1);
  });
});
