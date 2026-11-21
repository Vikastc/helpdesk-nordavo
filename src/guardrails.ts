// src/guardrails.ts — Input normalization, prompt-injection defense,
// XML data fencing, output leak scanning, and PII redaction.
// Adapted from battle-tested patterns (e.g. rubix_AI guardrails).

// ─── Unicode & Invisible Characters ───────────────────────────────

// Zero-width and bidirectional control characters used to disguise keywords
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const MAX_INPUT_LENGTH = 8_000;

/**
 * NFKC-normalizes text, strips invisible/bidi characters, and enforces length cap.
 * Ensures obfuscated attacks (e.g. "n\u200Begeer") match plain regex patterns.
 */
export function normalizeUntrustedText(text: string): string {
  const cleaned = text.normalize("NFKC").replace(INVISIBLE_CHARS, "").trim();
  return cleaned.length > MAX_INPUT_LENGTH
    ? cleaned.slice(0, MAX_INPUT_LENGTH)
    : cleaned;
}

// ─── Prompt Injection Heuristics (NL, EN, DE) ──────────────────────

/**
 * Hard block patterns: Proximity matching between action verbs and injection targets.
 * Covers English, Dutch (Roosterly's primary language), and German.
 */
const INJECTION_PATTERNS: ReadonlyArray<RegExp> = [
  // English: "ignore/disregard/forget ... previous/prior/above ... instructions/prompt/rules"
  /\b(ignore|disregard|forget)\b[\s\S]{0,40}\b(all\s+)?(previous|prior|above|earlier)\b[\s\S]{0,20}\b(instructions?|prompts?|rules?)\b/i,

  // Dutch: "negeer/vergeet ... alle eerdere/vorige ... instructies/regels" (e.g. ticket T007)
  /\b(negeer|vergeet)\b[\s\S]{0,40}\b(alle\s+)?(eerdere|vorige|bovenstaande)\b[\s\S]{0,20}\b(instructies?|regels?|prompts?)\b/i,

  // Dutch/English fake system headers: "SYSTEEMBERICHT: ...", "SYSTEM MESSAGE: ..."
  /(?:\b|\n)(?:systeembericht|system message)\s*:\s*[\s\S]{0,60}\b(negeer|ignore|instructies?|instructions?|korting|discount)\b/i,

  // Embedded notes targeting the AI: "notitie/note voor/for the AI/assistant/bot" (e.g. ticket T030)
  /(?:\b|\n)(?:--\s*)?(?:notitie|note|instructie|instruction)\s+(?:voor|for)\s+(?:de\s+)?(?:ai|assistent|assistant|bot|llm|model)\b/i,

  // Extraction attempts: "reveal/show/print ... system prompt / instructions"
  /\b(reveal|show|print|output|leak|expose|toon|onthul)\b[\s\S]{0,30}\b(system\s*prompt|system\s*message|systeembericht|your instructions|jouw instructies)\b/i,

  // Filter/guardrail bypasses: "bypass/override ... safety/guardrail/rules"
  /\b(bypass|override|disable|circumvent|omzeil|overschrijf)\b[\s\S]{0,30}\b(safety|guardrail|restriction|filter|instructions?|rules?|regels?)\b/i,

  // Jailbreak modes: "developer mode", "DAN mode", "jailbreak"
  /\b(developer\s+mode|dan\s+mode|jailbreak|modus\s+voor\s+ontwikkelaars)\b/i,

  // German: "ignoriere/vergiss ... alle vorherigen/früheren ... anweisungen/regeln"
  /\b(ignoriere|vergiss)\b[\s\S]{0,40}\b(alle\s+)?(vorherigen?|früheren?)\b[\s\S]{0,20}\b(anweisungen?|regeln?)\b/i,
];

export interface InjectionCheckResult {
  detected: boolean;
  patternMatched?: string;
}

/**
 * Fast, offline, zero-token scan for prompt-injection patterns.
 */
export function detectPromptInjection(rawText: string): InjectionCheckResult {
  const normalized = normalizeUntrustedText(rawText);
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        detected: true,
        patternMatched: pattern.source,
      };
    }
  }
  return { detected: false };
}

// ─── Untrusted Data Fencing ────────────────────────────────────────

/**
 * Fences customer-provided ticket data into XML tags so it is treated as data,
 * not system commands (indirect injection boundary).
 */
export function fenceTicketData(
  id: string,
  subject: string,
  body: string,
  channel: string,
  plan: string
): string {
  const safeSubject = normalizeUntrustedText(subject);
  const safeBody = normalizeUntrustedText(body);
  const safeChannel = normalizeUntrustedText(channel);
  const safePlan = normalizeUntrustedText(plan);

  return `<untrusted_customer_ticket id="${id}">
  <channel>${safeChannel}</channel>
  <customer_plan>${safePlan}</customer_plan>
  <subject>${safeSubject}</subject>
  <body>
${safeBody}
  </body>
</untrusted_customer_ticket>`;
}

// ─── Output Leak Scanner ───────────────────────────────────────────

const OUTPUT_LEAK_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(my|the|these)\s+instructions\s+(are|were|say)\b/i,
  /\bsystem\s+prompt\b[\s\S]{0,20}\b(is|says|:)\b/i,
  /\bhere\s+(are|is)\s+(my|the)\s+(instructions|system\s+prompt|rules)\b/i,
  /\bBearer\s+nrd_[a-zA-Z0-9_]+\b/i,
  /\b(mijn|deze)\s+instructies\s+(zijn|waren|zeggen)\b/i,
];

/**
 * Checks if a generated draft reply accidentally leaks system prompt instructions or API keys.
 */
export function detectOutputLeak(text: string): boolean {
  return OUTPUT_LEAK_PATTERNS.some((pattern) => pattern.test(text));
}

// ─── PII Scrubbing ─────────────────────────────────────────────────

// European & Dutch IBAN regex (e.g. NL91ABNA0417164300)
const IBAN_REGEX = /\b[A-Z]{2}\d{2}[A-Z0-9]{4,30}\b/g;

// Standard credit/debit card numbers (13-19 digits, optional dashes/spaces)
const CARD_REGEX = /\b(?:\d{4}[ -]?){3}\d{4}\b/g;

/**
 * Removes payment details (IBANs, card numbers) from text to comply with client privacy policy.
 */
export function stripPII(text: string): string {
  return text
    .replace(IBAN_REGEX, "[IBAN REDACTED]")
    .replace(CARD_REGEX, "[CARD REDACTED]");
}
