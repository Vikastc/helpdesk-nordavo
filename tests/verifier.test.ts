// tests/verifier.test.ts — Unit tests for Dutch language verification & grounding check.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  verifyDraftReply,
  applyVerificationSafetyNet,
} from "../src/verifier.js";
import type { Classification, VerificationResult } from "../src/types.js";
import { config } from "../src/config.js";

describe("Dutch Language Verification Safety-Net (src/verifier.ts)", () => {
  it("ignores non-reply actions (handoff / close) without invoking verifier", async () => {
    const handoffClassification: Classification = {
      language: "nl",
      category: "billing",
      priority: "P2",
      action: "handoff",
      reason: "Needs human review",
      handoff_note: "Refund requested",
    };

    const dummyTicket = { id: "T999", subject: "Test", body: "Test" };
    // Pass a dummy client that throws if called
    const dummyClient = {
      chat: {
        completions: {
          parse: async () => {
            throw new Error("Should not be called!");
          },
        },
      },
    } as any;

    const result = await applyVerificationSafetyNet(
      handoffClassification,
      dummyTicket,
      { client: dummyClient }
    );

    assert.equal(result.action, "handoff");
    assert.equal(result.verification, undefined);
  });

  it("preserves 'reply' action when verification succeeds (grounded = true)", async () => {
    const replyClassification: Classification = {
      language: "nl",
      category: "question",
      priority: "P4",
      action: "reply",
      reason: "Answered via FAQ F01",
      draft_reply:
        "Ga naar app.roosterly.nl/login en klik op Wachtwoord vergeten.",
    };

    const dummyTicket = {
      id: "T001",
      subject: "Wachtwoord kwijt",
      body: "Hoe reset ik mijn wachtwoord?",
    };

    const mockClient = {
      chat: {
        completions: {
          parse: async () => ({
            choices: [
              {
                message: {
                  parsed: {
                    back_translation:
                      "Go to app.roosterly.nl/login and click on Forgot password.",
                    grounded: true,
                    unsupported_claims: [],
                    explanation: "Directly matches F01.",
                  },
                },
              },
            ],
          }),
        },
      },
    } as any;

    const result = await applyVerificationSafetyNet(
      replyClassification,
      dummyTicket,
      { client: mockClient }
    );

    assert.equal(result.action, "reply");
    assert.equal(
      result.draft_reply,
      "Ga naar app.roosterly.nl/login en klik op Wachtwoord vergeten."
    );
    assert.ok(result.verification);
    assert.equal(result.verification?.grounded, true);
    assert.equal(result.verification?.unsupported_claims.length, 0);
  });

  it("overrides 'reply' to 'handoff' when verification detects hallucination (grounded = false)", async () => {
    const hallucinatedClassification: Classification = {
      language: "nl",
      category: "question",
      priority: "P4",
      action: "reply",
      reason: "Claimed refund policy",
      draft_reply:
        "Je kunt je geld terugvragen door te mailen naar refunds@roosterly.nl.",
    };

    const dummyTicket = {
      id: "T002",
      subject: "Geld terug",
      body: "Kan ik geld terugkrijgen?",
    };

    const mockClient = {
      chat: {
        completions: {
          parse: async () => ({
            choices: [
              {
                message: {
                  parsed: {
                    back_translation:
                      "You can request your money back by emailing refunds@roosterly.nl.",
                    grounded: false,
                    unsupported_claims: [
                      "Money back can be requested via email",
                      "refunds@roosterly.nl exists",
                    ],
                    explanation: "Roosterly FAQ has no refund email.",
                  },
                },
              },
            ],
          }),
        },
      },
    } as any;

    const result = await applyVerificationSafetyNet(
      hallucinatedClassification,
      dummyTicket,
      { client: mockClient }
    );

    // Verified override behavior:
    assert.equal(result.action, "handoff");
    assert.equal(result.draft_reply, undefined);
    assert.ok(result.handoff_note?.includes("GROUNDING CHECK FAILED"));
    assert.ok(result.handoff_note?.includes("refunds@roosterly.nl exists"));
    assert.ok(result.reason.includes("failed semantic grounding check"));
    assert.equal(result.verification?.grounded, false);
  });

  it("fails-safe to handoff if the verification LLM call encounters a network/API error", async () => {
    const replyClassification: Classification = {
      language: "nl",
      category: "question",
      priority: "P4",
      action: "reply",
      reason: "Answered via FAQ F01",
      draft_reply: "Probeer opnieuw in te loggen.",
    };

    const dummyTicket = {
      id: "T003",
      subject: "Login",
      body: "Inloggen lukt niet.",
    };

    const errorClient = {
      chat: {
        completions: {
          parse: async () => {
            throw new Error("Anthropic 500 Internal Server Error");
          },
        },
      },
    } as any;

    const result = await applyVerificationSafetyNet(
      replyClassification,
      dummyTicket,
      { client: errorClient }
    );

    // Fail-safe guarantee: Never send unverified reply to customer on error
    assert.equal(result.action, "handoff");
    assert.equal(result.draft_reply, undefined);
    assert.equal(result.verification?.grounded, false);
    assert.ok(result.handoff_note?.includes("GROUNDING CHECK FAILED"));
  });

  it("strictly scrubs PII from back-translations and handoff notes", async () => {
    const classification: Classification = {
      language: "nl",
      category: "question",
      priority: "P4",
      action: "reply",
      reason: "Check account",
      draft_reply: "We hebben het gecheckt voor IBAN NL91ABNA0417164300.",
    };

    const dummyTicket = { id: "T004", subject: "IBAN", body: "Mijn rekening" };

    const mockClient = {
      chat: {
        completions: {
          parse: async () => ({
            choices: [
              {
                message: {
                  parsed: {
                    back_translation:
                      "We checked it for IBAN NL91ABNA0417164300.",
                    grounded: false,
                    unsupported_claims: ["IBAN NL91ABNA0417164300 verified"],
                    explanation: "Contains personal IBAN.",
                  },
                },
              },
            ],
          }),
        },
      },
    } as any;

    const result = await applyVerificationSafetyNet(
      classification,
      dummyTicket,
      { client: mockClient }
    );

    assert.equal(result.action, "handoff");
    assert.doesNotMatch(result.handoff_note ?? "", /NL91ABNA0417164300/);
    assert.match(result.handoff_note ?? "", /\[IBAN REDACTED\]/);
  });
});

describe("Live Dutch Verification against Claude (if API key available)", () => {
  it("verifies grounded Dutch password reset reply with real Claude call", async () => {
    if (!config.llm.apiKey) return;

    const ticket = {
      subject: "Kan niet inloggen",
      body: "Hoi, ik ben mijn wachtwoord vergeten. Hoe kom ik er weer in?",
    };
    const draftReply =
      "Hoi! Geen probleem: ga naar app.roosterly.nl/login en klik op 'Wachtwoord vergeten'. Vul je e-mailadres in, de link is 60 minuten geldig. Kijk na 10 minuten ook in je spammap.";

    const result = await verifyDraftReply(ticket, draftReply);

    assert.ok(result.back_translation.length > 0);
    assert.equal(result.grounded, true);
    assert.equal(result.unsupported_claims.length, 0);
  });

  it("catches hallucinated refund offer with real Claude call", async () => {
    if (!config.llm.apiKey) return;

    const ticket = {
      subject: "Abonnement",
      body: "Ik wil graag een vergoeding voor vorige week.",
    };
    const draftReply =
      "Hoi! Wij storten automatisch €50 terug op je rekening binnen 2 werkdagen via WhatsApp support.";

    const result = await verifyDraftReply(ticket, draftReply);

    assert.ok(result.back_translation.length > 0);
    assert.equal(result.grounded, false);
    assert.ok(result.unsupported_claims.length > 0);
  });
});
