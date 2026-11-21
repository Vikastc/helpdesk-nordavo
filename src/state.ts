// src/state.ts — Functional state management for crash recovery and idempotency.
// Persists handled ticket IDs so the agent can safely resume without re-processing.

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { AgentState } from "./types.js";

const DEFAULT_STATE_DIR = path.resolve("data");
const DEFAULT_STATE_FILE = path.join(DEFAULT_STATE_DIR, "state.json");

export const createInitialState = (runId = crypto.randomUUID()): AgentState => ({
  run_id: runId,
  handled_tickets: {},
});

export const loadState = (filePath = DEFAULT_STATE_FILE): AgentState => {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(content) as AgentState;
    }
  } catch (err) {
    console.warn(`⚠️ Could not read state file at ${filePath}, initializing new state:`, err);
  }
  return createInitialState();
};

export const saveState = (state: AgentState, filePath = DEFAULT_STATE_FILE): void => {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
};

export const isTicketHandled = (state: AgentState, ticketId: string): boolean =>
  ticketId in state.handled_tickets;

export const recordTicketHandled = (
  state: AgentState,
  ticketId: string,
  action: string,
  filePath = DEFAULT_STATE_FILE
): AgentState => {
  const updatedState: AgentState = {
    ...state,
    handled_tickets: {
      ...state.handled_tickets,
      [ticketId]: {
        action,
        timestamp: new Date().toISOString(),
      },
    },
  };
  saveState(updatedState, filePath);
  return updatedState;
};

export const resetLocalState = (filePath = DEFAULT_STATE_FILE): AgentState => {
  const fresh = createInitialState();
  saveState(fresh, filePath);
  return fresh;
};
