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
1. Translate non-English draft customer replies into precise English ("back_translation"). If already in English, output the English text.
2. Check whether the draft reply is grounded in and supported by the Official Roosterly Knowledge Base above:
   - Factual grounding: All product specifications, prices, URLs, and documented requirements must strictly match the FAQ.
   - Logical application: Applying an FAQ premise to the customer's stated facts (such as determining whether a customer's setup meets minimum system requirements, or directing them to a documented portal/URL) is valid deduction, not a hallucination.
   - Professional etiquette: Standard greetings, polite sign-offs, and recommending supported setups do NOT count as hallucinations.
3. When to fail ("grounded": false):
   - ONLY set "grounded": false if the reply invents ungrounded business policies, promises refunds/discounts, gives inaccurate prices, invents fake URLs or email addresses, or promises features not in the FAQ.
   - List any such invented claims in "unsupported_claims".
4. If the reply is consistent with the FAQ, set "grounded": true and leave "unsupported_claims" as [].
5. Provide a concise explanation of your assessment in "explanation".`;

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

    const usage = response.usage
      ? {
          prompt_tokens: response.usage.prompt_tokens,
          completion_tokens: response.usage.completion_tokens,
          total_tokens: response.usage.total_tokens,
        }
      : undefined;

    return {
      back_translation: parsed.back_translation,
      grounded: parsed.grounded,
      unsupported_claims: parsed.unsupported_claims ?? [],
      explanation: parsed.explanation,
      usage,
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

  const combinedUsage =
    classification.usage || verification.usage
      ? {
          prompt_tokens:
            (classification.usage?.prompt_tokens ?? 0) +
            (verification.usage?.prompt_tokens ?? 0),
          completion_tokens:
            (classification.usage?.completion_tokens ?? 0) +
            (verification.usage?.completion_tokens ?? 0),
          total_tokens:
            (classification.usage?.total_tokens ?? 0) +
            (verification.usage?.total_tokens ?? 0),
        }
      : undefined;

  const updated: Classification = {
    ...classification,
    verification,
    usage: combinedUsage,
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
