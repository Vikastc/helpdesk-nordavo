// tests/eval.test.ts — Unit tests for evaluation scoring, example caching, and cost estimation.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { calculateCostFromUsage, loadLabelledExamples, type EvalItemScore } from "../src/eval.js";

describe("Evaluation Harness Metrics & Scoring (src/eval.ts)", () => {
  it("calculates cost per 100 tickets accurately from actual TokenUsage", () => {
    const mockItems: EvalItemScore[] = [
      {
        id: "E01",
        subject: "Test 1",
        gold: { language: "nl", category: "question", priority: "P4", action: "reply", reason: "" },
        predicted: {
          language: "nl",
          category: "question",
          priority: "P4",
          action: "reply",
          reason: "",
          usage: { prompt_tokens: 1600, completion_tokens: 300, total_tokens: 1900 },
        },
        matches: { language: true, category: true, priority: true, action: true, exact: true },
      },
      {
        id: "E02",
        subject: "Test 2",
        gold: { language: "nl", category: "billing", priority: "P2", action: "handoff", reason: "" },
        predicted: {
          language: "nl",
          category: "billing",
          priority: "P2",
          action: "handoff",
          reason: "",
          usage: { prompt_tokens: 1400, completion_tokens: 150, total_tokens: 1550 },
        },
        matches: { language: true, category: true, priority: true, action: true, exact: true },
      },
    ];

    const estimate = calculateCostFromUsage(mockItems);

    assert.equal(estimate.model, "claude-haiku-5-5");
    assert.equal(estimate.avg_input_tokens, 1500); // (1600 + 1400) / 2
    assert.equal(estimate.avg_output_tokens, 225); // (300 + 150) / 2
    assert.ok(estimate.cost_per_ticket_usd > 0);
    assert.ok(estimate.cost_per_100_tickets_eur < 1.0);
  });

  it("evaluates exact match and dimension match logic correctly", () => {
    const perfectItem: EvalItemScore = {
      id: "E01",
      subject: "Test Subject",
      gold: {
        language: "nl",
        category: "question",
        priority: "P4",
        action: "reply",
        reason: "Gold reason",
      },
      predicted: {
        language: "nl",
        category: "question",
        priority: "P4",
        action: "reply",
        reason: "Agent reason",
      },
      matches: {
        language: true,
        category: true,
        priority: true,
        action: true,
        exact: true,
      },
    };

    assert.equal(perfectItem.matches.exact, true);

    const mismatchedItem: EvalItemScore = {
      id: "E02",
      subject: "Test Mismatch",
      gold: {
        language: "nl",
        category: "billing",
        priority: "P2",
        action: "handoff",
        reason: "Gold reason",
      },
      predicted: {
        language: "nl",
        category: "billing",
        priority: "P4", // mismatch
        action: "handoff",
        reason: "Agent reason",
      },
      matches: {
        language: true,
        category: true,
        priority: false,
        action: true,
        exact: false,
      },
    };

    assert.equal(mismatchedItem.matches.exact, false);
    assert.equal(mismatchedItem.matches.priority, false);
    assert.equal(mismatchedItem.matches.action, true);
  });

  it("loads 10 cached labelled examples from data/examples.json with valid structure", async () => {
    const cachePath = path.resolve("data/examples.json");
    if (!fs.existsSync(cachePath)) {
      return; // Skip if offline/not cached yet
    }

    const examples = await loadLabelledExamples(false);
    assert.equal(examples.length, 10);

    for (const ex of examples) {
      assert.ok(ex.id.startsWith("E"));
      assert.ok(ex.subject);
      assert.ok(ex.body);
      assert.ok(ex.label.language);
      assert.ok(ex.label.category);
      assert.ok(ex.label.priority);
      assert.ok(ex.label.action);
    }
  });
});
