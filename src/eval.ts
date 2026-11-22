// src/eval.ts — Evaluation harness for scoring agent against gold-standard labelled examples.
// Evaluates language, category, priority, and action accuracy, tracking token cost.

import * as fs from "node:fs";
import * as path from "node:path";
import * as client from "./client.js";
import { classifyTicket } from "./classifier.js";
import type { LabelledExample, Ticket, Classification, TokenUsage } from "./types.js";

const EXAMPLES_CACHE_PATH = path.resolve("data/examples.json");

export interface EvalItemScore {
  id: string;
  subject: string;
  gold: {
    language: string;
    category: string;
    priority: string;
    action: string;
    reason: string;
  };
  predicted: {
    language: string;
    category: string;
    priority: string;
    action: string;
    reason: string;
    draft_reply?: string;
    handoff_note?: string;
    grounded?: boolean;
    usage?: TokenUsage;
  };
  matches: {
    language: boolean;
    category: boolean;
    priority: boolean;
    action: boolean;
    exact: boolean;
  };
}

export interface CostEstimate {
  model: string;
  avg_input_tokens: number;
  avg_output_tokens: number;
  cost_per_ticket_usd: number;
  cost_per_100_tickets_usd: number;
  cost_per_100_tickets_eur: number;
}

/**
 * Calculates actual token consumption and financial cost based on real API response usage.
 */
export function calculateCostFromUsage(items: EvalItemScore[]): CostEstimate {
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let itemsWithUsage = 0;

  for (const item of items) {
    if (item.predicted.usage) {
      totalPromptTokens += item.predicted.usage.prompt_tokens;
      totalCompletionTokens += item.predicted.usage.completion_tokens;
      itemsWithUsage++;
    }
  }

  const count = itemsWithUsage > 0 ? itemsWithUsage : items.length;
  const avgInputTokens = count > 0 ? Math.round(totalPromptTokens / count) : 0;
  const avgOutputTokens = count > 0 ? Math.round(totalCompletionTokens / count) : 0;

  // Claude Haiku pricing ($0.80 / MTok in, $4.00 / MTok out)
  const totalCostUsd =
    (totalPromptTokens / 1_000_000) * 0.8 + (totalCompletionTokens / 1_000_000) * 4.0;
  const costPerTicket = count > 0 ? totalCostUsd / count : 0;
  const costPer100Usd = costPerTicket * 100;
  const costPer100Eur = costPer100Usd * 0.95;

  return {
    model: "claude-haiku-5-5",
    avg_input_tokens: avgInputTokens,
    avg_output_tokens: avgOutputTokens,
    cost_per_ticket_usd: Number(costPerTicket.toFixed(5)),
    cost_per_100_tickets_usd: Number(costPer100Usd.toFixed(3)),
    cost_per_100_tickets_eur: Number(costPer100Eur.toFixed(3)),
  };
}

export interface EvalReport {
  timestamp: string;
  total_examples: number;
  cost_estimate: CostEstimate;
  metrics: {
    language_accuracy: number;
    category_accuracy: number;
    priority_accuracy: number;
    action_accuracy: number;
    exact_match_accuracy: number;
  };
  counts: {
    language_matches: number;
    category_matches: number;
    priority_matches: number;
    action_matches: number;
    exact_matches: number;
  };
  items: EvalItemScore[];
}

/**
 * Loads labelled examples from local cache if present, otherwise fetches from API.
 */
export async function loadLabelledExamples(forceRefresh = false): Promise<LabelledExample[]> {
  if (!forceRefresh && fs.existsSync(EXAMPLES_CACHE_PATH)) {
    try {
      const raw = fs.readFileSync(EXAMPLES_CACHE_PATH, "utf-8");
      return JSON.parse(raw) as LabelledExample[];
    } catch {
      // Fall through to API fetch
    }
  }

  console.log("📥 Fetching gold examples from GET /examples...");
  const examples = await client.getExamples();
  
  // Cache to disk for offline evaluation and reproducibility
  const dir = path.dirname(EXAMPLES_CACHE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(EXAMPLES_CACHE_PATH, JSON.stringify(examples, null, 2), "utf-8");
  return examples;
}

/**
 * Evaluates a single labelled example against the classifier pipeline.
 */
export async function evaluateExample(example: LabelledExample): Promise<EvalItemScore> {
  const ticket: Ticket = {
    id: example.id,
    subject: example.subject,
    body: example.body,
    channel: example.channel ?? "email",
    customer_plan: example.customer_plan ?? "Basis",
    received_at: new Date().toISOString(),
  };

  const decision: Classification = await classifyTicket(ticket);

  const langMatch = decision.language === example.label.language;
  const catMatch = decision.category === example.label.category;
  const priMatch = decision.priority === example.label.priority;
  const actMatch = decision.action === example.label.action;
  const exactMatch = langMatch && catMatch && priMatch && actMatch;

  return {
    id: example.id,
    subject: example.subject,
    gold: {
      language: example.label.language,
      category: example.label.category,
      priority: example.label.priority,
      action: example.label.action,
      reason: example.label.reason,
    },
    predicted: {
      language: decision.language,
      category: decision.category,
      priority: decision.priority,
      action: decision.action,
      reason: decision.reason,
      draft_reply: decision.draft_reply,
      handoff_note: decision.handoff_note,
      grounded: decision.verification?.grounded,
      usage: decision.usage,
    },
    matches: {
      language: langMatch,
      category: catMatch,
      priority: priMatch,
      action: actMatch,
      exact: exactMatch,
    },
  };
}

/**
 * Runs evaluation across all labelled examples and aggregates metrics.
 */
export async function runEvaluation(options: { forceRefresh?: boolean } = {}): Promise<EvalReport> {
  console.log("\n🧪 Running Evaluation against 10 Gold-Standard Examples...\n");
  const examples = await loadLabelledExamples(options.forceRefresh);
  const items: EvalItemScore[] = [];

  for (const ex of examples) {
    process.stdout.write(`   Evaluating ${ex.id} (${ex.subject})... `);
    const score = await evaluateExample(ex);
    items.push(score);
    if (score.matches.exact) {
      console.log("✅ Exact Match");
    } else {
      const failedFields: string[] = [];
      if (!score.matches.action) failedFields.push(`action [${score.predicted.action} vs ${score.gold.action}]`);
      if (!score.matches.category) failedFields.push(`category [${score.predicted.category} vs ${score.gold.category}]`);
      if (!score.matches.priority) failedFields.push(`priority [${score.predicted.priority} vs ${score.gold.priority}]`);
      if (!score.matches.language) failedFields.push(`language [${score.predicted.language} vs ${score.gold.language}]`);
      console.log(`⚠️  Mismatch: ${failedFields.join(", ")}`);
    }
  }

  const total = items.length;
  const langMatches = items.filter((i) => i.matches.language).length;
  const catMatches = items.filter((i) => i.matches.category).length;
  const priMatches = items.filter((i) => i.matches.priority).length;
  const actMatches = items.filter((i) => i.matches.action).length;
  const exactMatches = items.filter((i) => i.matches.exact).length;

  const costEstimate = calculateCostFromUsage(items);

  const report: EvalReport = {
    timestamp: new Date().toISOString(),
    total_examples: total,
    cost_estimate: costEstimate,
    metrics: {
      language_accuracy: total > 0 ? (langMatches / total) * 100 : 0,
      category_accuracy: total > 0 ? (catMatches / total) * 100 : 0,
      priority_accuracy: total > 0 ? (priMatches / total) * 100 : 0,
      action_accuracy: total > 0 ? (actMatches / total) * 100 : 0,
      exact_match_accuracy: total > 0 ? (exactMatches / total) * 100 : 0,
    },
    counts: {
      language_matches: langMatches,
      category_matches: catMatches,
      priority_matches: priMatches,
      action_matches: actMatches,
      exact_matches: exactMatches,
    },
    items,
  };

  printReport(report);
  return report;
}

/**
 * Prints a clean scorecard table and error breakdown to stdout.
 */
function printReport(report: EvalReport): void {
  console.log("\n════════════════════════════════════════════════════════════════════════════════════");
  console.log("📊 EVALUATION SCORECARD (10 Labeled Examples)");
  console.log("════════════════════════════════════════════════════════════════════════════════════\n");

  console.log(
    "ID   | Action (Pred / Gold) | Category (Pred / Gold)  | Pri (Pred/Gold) | Lang | Match"
  );
  console.log(
    "-----+----------------------+-------------------------+-----------------+------+------"
  );

  for (const item of report.items) {
    const act = `${item.predicted.action} / ${item.gold.action}`.padEnd(20);
    const cat = `${item.predicted.category} / ${item.gold.category}`.padEnd(23);
    const pri = `${item.predicted.priority} / ${item.gold.priority}`.padEnd(15);
    const lang = item.matches.language ? "OK  " : "FAIL";
    const status = item.matches.exact ? "✅ PASS" : "❌ DIFF";

    console.log(`${item.id}  | ${act} | ${cat} | ${pri} | ${lang} | ${status}`);
  }

  console.log("\n────────────────────────────────────────────────────────────────────────────────────");
  console.log("📈 ACCURACY METRICS:");
  console.log(`   • Language Accuracy:    ${report.counts.language_matches}/${report.total_examples} (${report.metrics.language_accuracy.toFixed(1)}%)`);
  console.log(`   • Action Accuracy:      ${report.counts.action_matches}/${report.total_examples} (${report.metrics.action_accuracy.toFixed(1)}%)`);
  console.log(`   • Category Accuracy:    ${report.counts.category_matches}/${report.total_examples} (${report.metrics.category_accuracy.toFixed(1)}%)`);
  console.log(`   • Priority Accuracy:    ${report.counts.priority_matches}/${report.total_examples} (${report.metrics.priority_accuracy.toFixed(1)}%)`);
  console.log(`   🎯 Exact Match:         ${report.counts.exact_matches}/${report.total_examples} (${report.metrics.exact_match_accuracy.toFixed(1)}%)`);
  console.log("────────────────────────────────────────────────────────────────────────────────────\n");

  console.log("💰 COST ESTIMATION & TOKEN USAGE (Claude Haiku 5.5):");
  console.log(`   • Model:                ${report.cost_estimate.model}`);
  console.log(`   • Avg Tokens / Ticket:  ~${report.cost_estimate.avg_input_tokens} input, ~${report.cost_estimate.avg_output_tokens} output`);
  console.log(`   • Cost per ticket:      $${report.cost_estimate.cost_per_ticket_usd.toFixed(4)} USD`);
  console.log(`   • Cost per 100 tickets: $${report.cost_estimate.cost_per_100_tickets_usd.toFixed(2)} USD (~€${report.cost_estimate.cost_per_100_tickets_eur.toFixed(2)})`);
  console.log("────────────────────────────────────────────────────────────────────────────────────\n");

  const mismatches = report.items.filter((i) => !i.matches.exact);
  if (mismatches.length > 0) {
    console.log("🔍 MISMATCH ANALYSIS & ERROR BREAKDOWN:\n");
    for (const m of mismatches) {
      console.log(`[${m.id}] "${m.subject}"`);
      if (!m.matches.action) {
        console.log(`   • Action Mismatch:   Predicted '${m.predicted.action}', Gold is '${m.gold.action}'`);
      }
      if (!m.matches.category) {
        console.log(`   • Category Mismatch: Predicted '${m.predicted.category}', Gold is '${m.gold.category}'`);
      }
      if (!m.matches.priority) {
        console.log(`   • Priority Mismatch: Predicted '${m.predicted.priority}', Gold is '${m.gold.priority}'`);
      }
      if (!m.matches.language) {
        console.log(`   • Language Mismatch: Predicted '${m.predicted.language}', Gold is '${m.gold.language}'`);
      }
      console.log(`   • Gold Reason:       "${m.gold.reason}"`);
      console.log(`   • Agent Reason:      "${m.predicted.reason}"`);
      console.log("");
    }
  } else {
    console.log("🎉 Perfect score! All 10 examples matched gold labels across all dimensions.\n");
  }
}
