// src/rules.ts — Deterministic business rule enforcement and safety-net overrides.
// Ensures 100% compliance with client non-negotiable escalation rules and privacy policies.

import type { Classification, Ticket } from "./types.js";
import {
  detectOutputLeak,
  stripPII,
  normalizeUntrustedText,
} from "./guardrails.js";

// ─── Mandatory Escalation Policy Dictionaries ─────────────────────

export interface EscalationRule {
  name: string;
  category: "billing" | "bug" | "other";
  minPriority: "P1" | "P2" | "P3" | "P4";
  keywords: string[];
  englishDescription: string;
}

export const MANDATORY_ESCALATION_RULES: EscalationRule[] = [
  {
    name: "Refunds and Disputed Charges",
    category: "billing",
    minPriority: "P2",
    englishDescription: "Refund or disputed charge requested. Client rule: refunds always go to a human.",
    keywords: [
      "terugbetaling",
      "terugbetalen",
      "terugbetaald",
      "terugstorten",
      "terugkrijgen",
      "geld terug",
      "creditnota",
      "credit note",
      "betwist",
      "dispute",
      "refund",
      "rückerstattung",
      "erstattung",
    ],
  },
  {
    name: "Cancellations and Contract Changes",
    category: "billing",
    minPriority: "P2",
    englishDescription: "Cancellation or contract change request. Client rule: contract modifications always go to a human.",
    keywords: [
      "opzeggen",
      "opzegging",
      "annuleren",
      "annulering",
      "contract beëindigen",
      "abonnement beëindigen",
      "contract opzeggen",
      "cancel subscription",
      "cancellation",
      "terminate contract",
      "kündigen",
      "kündigung",
    ],
  },
  {
    name: "GDPR and Personal Data Requests",
    category: "other",
    minPriority: "P2",
    englishDescription: "GDPR/AVG data subject request. Client rule: personal data access/deletion requests always go to a human.",
    keywords: [
      "avg",
      "gdpr",
      "persoonsgegevens",
      "inzageverzoek",
      "verwijderverzoek",
      "recht op vergetelheid",
      "data protection",
      "personal data",
      "data deletion",
      "datenschutz",
    ],
  },
  {
    name: "Security Incidents and Breaches",
    category: "other",
    minPriority: "P1",
    englishDescription: "Possible security incident or vulnerability reported. Client rule: security incidents always go to a human.",
    keywords: [
      "beveiligingslek",
      "gehackt",
      "hack",
      "datalek",
      "data breach",
      "security incident",
      "unauthorized access",
      "sicherheitslücke",
      "kwetsbaarheid",
    ],
  },
  {
    name: "Legal Threats",
    category: "other",
    minPriority: "P1",
    englishDescription: "Legal action or liability threatened. Client rule: legal threats always go to a human.",
    keywords: [
      "advocaat",
      "juridisch",
      "aansprakelijk",
      "rechtszaak",
      "rechter",
      "lawyer",
      "legal action",
      "lawsuit",
      "liable",
      "rechtsanwalt",
      "anwalt",
      "schadevergoeding",
    ],
  },
  {
    name: "Customer Churn Threats",
    category: "other",
    minPriority: "P2",
    englishDescription: "Customer threatening to leave Roosterly. Client rule: churn risks always go to a human.",
    keywords: [
      "overstappen",
      "weggaan bij roosterly",
      "stoppen met roosterly",
      "concurrent",
      "switch provider",
      "leaving roosterly",
      "switch to competitor",
      "wechseln",
    ],
  },
];

// ─── Escalation Detection ──────────────────────────────────────────

export interface MatchedEscalation {
  ruleName: string;
  matchedKeyword: string;
  minPriority: "P1" | "P2" | "P3" | "P4";
  englishDescription: string;
}

/**
 * Checks if ticket subject or body matches any mandatory human-escalation keywords.
 */
export function findEscalationTriggers(ticket: Ticket): MatchedEscalation[] {
  const normalized = normalizeUntrustedText(`${ticket.subject} ${ticket.body}`).toLowerCase();
  const matches: MatchedEscalation[] = [];

  for (const rule of MANDATORY_ESCALATION_RULES) {
    for (const kw of rule.keywords) {
      // Check word boundary where applicable
      const regex = new RegExp(`\\b${kw.replace(/[-\\/\\\\^$*+?.()|[\\]{}]/g, "\\$&")}\\b`, "i");
      if (regex.test(normalized)) {
        matches.push({
          ruleName: rule.name,
          matchedKeyword: kw,
          minPriority: rule.minPriority,
          englishDescription: rule.englishDescription,
        });
        break; // Match rule once
      }
    }
  }

  return matches;
}

// ─── Priority Elevation Helper ────────────────────────────────────

const PRIORITY_ORDER: Record<string, number> = {
  P1: 1,
  P2: 2,
  P3: 3,
  P4: 4,
};

function elevatePriority(current: "P1" | "P2" | "P3" | "P4", target: "P1" | "P2" | "P3" | "P4"): "P1" | "P2" | "P3" | "P4" {
  return PRIORITY_ORDER[target] < PRIORITY_ORDER[current] ? target : current;
}

// ─── Main Rule Applier ────────────────────────────────────────────

/**
 * Pure function: applies deterministic safety net, prompt-injection defense,
 * client business escalation rules, and PII scrubbing.
 */
export function applyBusinessRules(
  classification: Classification,
  ticket: Ticket
): Classification {
  let result: Classification = { ...classification };

  // ── 1. Mandatory Human Escalation Rules (Refunds, Cancellations, GDPR, etc.) ──
  const escalations = findEscalationTriggers(ticket);
  if (escalations.length > 0 && result.action === "reply") {
    const primaryRule = escalations[0];
    console.warn(
      `  🛡️  Safety-Net Override: "${result.action}" → "handoff" for ${ticket.id} (${primaryRule.ruleName} [keyword: "${primaryRule.matchedKeyword}"])`
    );

    result.action = "handoff";
    result.priority = elevatePriority(result.priority, primaryRule.minPriority);
    result.reason = `${primaryRule.englishDescription} (Triggered by: "${primaryRule.matchedKeyword}"). Original reason: ${result.reason}`;

    if (!result.handoff_note) {
      result.handoff_note = `${primaryRule.englishDescription} Customer inquiry requires manual review under company policy.`;
    }

    // Never auto-reply when human handoff is mandated
    delete result.draft_reply;
  }

  // ── 3. Output Leak Scanner (Checks Draft Reply) ──
  if (result.draft_reply && detectOutputLeak(result.draft_reply)) {
    console.warn(
      `  🛡️  Safety-Net Override: Draft reply on ${ticket.id} leaked internal instructions! Forcing handoff.`
    );
    result.action = "handoff";
    result.reason = "Internal safety override: generated draft reply attempted to quote system instructions.";
    result.handoff_note = "Auto-reply blocked because the LLM generated internal instruction phrasing. Needs manual review.";
    delete result.draft_reply;
  }

  // ── 4. PII Scrubbing (IBANs & Payment Cards) ──
  if (result.draft_reply) {
    result.draft_reply = stripPII(result.draft_reply);
  }
  if (result.handoff_note) {
    result.handoff_note = stripPII(result.handoff_note);
  }
  result.reason = stripPII(result.reason);

  return result;
}
