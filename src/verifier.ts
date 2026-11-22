// src/verifier.ts — Dutch language verification & semantic grounding check.
// Translates non-English replies back to English and strictly verifies claims against Roosterly FAQ.

import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { config } from "./config.js";
import { FAQ_KNOWLEDGE_BASE } from "./knowledge.js";
import {
  LlmVerificationSchema,
  type VerificationResult,
  type Classification,
} from "./types.js";
import { stripPII } from "./guardrails.js";

// ─── Verifier System Prompt ────────────────────────────────────────

const VERIFIER_SYSTEM_PROMPT = `You are a strict QA and Grounding Auditor for Roosterly's customer support helpdesk.
Roosterly is a Dutch shift-planning SaaS for restaurants and shops.

## OFFICIAL ROOSTERLY KNOWLEDGE BASE (THE ONLY GROUND TRUTH):
${FAQ_KNOWLEDGE_BASE}

## YOUR TASK:
1. Translate the Dutch/non-English draft customer reply into precise English ("back_translation").
2. Check whether EVERY factual statement, step, URL, plan detail, and instruction in the reply is 100% grounded in and supported by the Official Roosterly Knowledge Base above.
3. If the reply invents any information, promises features not in the FAQ, gives ungrounded instructions, promises refunds, or guesses facts, you MUST set "grounded": false and list each unsupported claim in "unsupported_claims".
4. If and only if EVERY factual claim in the reply is completely accurate and grounded in the FAQ, set "grounded": true and leave "unsupported_claims" as an empty list [].
5. Provide a concise explanation of your grounding assessment in "explanation".`;

// ─── OpenAI Client Lazy Initializer ───────────────────────────────

let openaiInstance: OpenAI | undefined;

function getOpenAIClient(): OpenAI {
  if (!openaiInstance) {
    openaiInstance = new OpenAI({
      apiKey: config.llm.apiKey,
      baseURL: config.llm.baseUrl,
      defaultHeaders: {
        "x-api-key": config.llm.apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
  }
  return openaiInstance;
}

// ─── Public Verification Functions ────────────────────────────────

/**
 * Performs back-translation to English and validates that all factual claims
 * are strictly grounded in Roosterly's 12 FAQ articles.
 */
export async function verifyDraftReply(
  ticket: { subject: string; body: string },
  draftReply: string,
  options: { client?: OpenAI; model?: string } = {}
): Promise<VerificationResult> {
  const client = options.client ?? getOpenAIClient();
  const model = options.model ?? config.llm.model;

  try {
    const response = await client.chat.completions.parse({
      model,
      messages: [
        { role: "system", content: VERIFIER_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Customer Ticket Subject: "${ticket.subject}"\nCustomer Ticket Body: "${ticket.body}"\n\nProposed Draft Reply:\n"${draftReply}"`,
        },
      ],
      response_format: zodResponseFormat(
        LlmVerificationSchema,
        "verification_result"
      ),
    });

    const parsed = response.choices[0]?.message?.parsed;
    if (!parsed) {
      throw new Error("Verification parsing returned null");
    }

    return {
      back_translation: parsed.back_translation,
      grounded: parsed.grounded,
      unsupported_claims: parsed.unsupported_claims ?? [],
      explanation: parsed.explanation,
    };
  } catch (err) {
    console.error("  ⚠️  Verification error:", err);
    // Fail-safe: if verification fails, treat as ungrounded so an unverified reply is never sent
    return {
      back_translation: "[VERIFICATION ERROR - FAIL-SAFE ACTIVATED]",
      grounded: false,
      unsupported_claims: ["Verification execution failed"],
      explanation: (err as Error).message ?? String(err),
    };
  }
}

/**
 * Applies Dutch language verification and grounding safety-net to a classification.
 * If action is 'reply' and draft_reply exists:
 *   1. Runs back-translation and FAQ grounding check.
 *   2. Attaches verification result.
 *   3. If ungrounded or contains unsupported claims:
 *      - Overrides action to 'handoff'.
 *      - Clears draft_reply.
 *      - Sets informative handoff_note and reason.
 */
export async function applyVerificationSafetyNet(
  classification: Classification,
  ticket: { id: string; subject: string; body: string },
  options: { client?: OpenAI; model?: string } = {}
): Promise<Classification> {
  // Only verify when an automated reply is proposed
  if (classification.action !== "reply" || !classification.draft_reply) {
    return classification;
  }

  const verification = await verifyDraftReply(
    ticket,
    classification.draft_reply,
    options
  );

  const updated: Classification = {
    ...classification,
    verification,
  };

  if (!verification.grounded || verification.unsupported_claims.length > 0) {
    const claimsStr =
      verification.unsupported_claims.length > 0
        ? verification.unsupported_claims.join("; ")
        : "unsupported claims detected";

    console.warn(
      `  🛡️  Verification Override: "reply" → "handoff" for ${ticket.id} (Grounding check failed: ${claimsStr})`
    );

    return {
      ...updated,
      action: "handoff",
      draft_reply: undefined,
      handoff_note: stripPII(
        `GROUNDING CHECK FAILED: Automated draft reply contained unsupported claims not in the FAQ: ${claimsStr}. English back-translation: "${verification.back_translation}". Escalated for human agent review.`
      ),
      reason: stripPII(
        `Draft reply failed semantic grounding check (${verification.explanation}). Escalated to human.`
      ),
    };
  }

  return updated;
}
