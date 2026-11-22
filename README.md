# Roosterly Helpdesk Support Agent

Autonomous AI agent that triages and responds to customer support tickets for Roosterly, a Dutch shift-planning SaaS. It reads every open ticket, decides whether to reply, hand off to a human, or close it, and posts that decision back — all in one command.

---

## How to run

```bash
git clone git@github.com:Vikastc/helpdesk-nordavo.git
cd helpdesk-nordavo
npm install
cp .env.example .env        # then fill in your keys
npm start                    # process all open tickets
npm run eval                 # run evaluation on the 10 gold examples
npm test                     # run all 37 unit & integration tests
```

---

## Decisions

1. **Model & SDK**: Claude Haiku 5.5 via the OpenAI Node SDK, using native structured JSON outputs (`zodResponseFormat`). Chosen for speed, low cost (~€0.14 for all 30 practice tickets), and reliable schema adherence.

2. **Dutch language handling**: The agent replies directly in the customer's language (mostly Dutch). Since I can't read Dutch myself, every draft reply goes through a second LLM call that back-translates it to English and checks every claim against the FAQ. If anything is hallucinated — a made-up URL, an invented policy, a wrong price — the reply is automatically downgraded to a human handoff. This way, no unverified Dutch text ever reaches a customer.

3. **Safety over helpfulness**: Six categories of tickets (refunds, cancellations, GDPR/AVG, security, legal threats, churn risk) are *always* escalated to a human, even if the FAQ seems relevant. This is enforced by deterministic keyword rules that override the LLM, so the model can never talk its way past them. Ticket text is also fenced inside XML tags and scanned for prompt injection attempts before the LLM sees it.

4. **AI tools used**: Built with Antigravity (Claude-based pair-programming agent) for scaffolding, test writing, and prompt calibration.

---

## Reliability

- **503 (transient failures)**: Exponential backoff with jitter, up to 5 retries.
- **429 (rate limits)**: Self-throttling at 4 req/s (below the 5/s limit), plus `Retry-After` header respect.
- **409 (duplicate answers)**: A local checkpoint file (`data/state.json`) tracks every handled ticket. After a crash, the agent picks up where it left off. If the API still returns 409, it's recorded and skipped — no customer ever gets two answers.
- **PII**: IBANs and card numbers are stripped from all replies, handoff notes, and log files.
- **Secrets**: All keys come from environment variables; `.env` is gitignored.

---

## Eval and fix

**Baseline**: 8/10 exact match on the 10 gold-standard examples from `GET /examples`.

Two tickets were wrong:
- **E01** ("App crashes on iPhone 8 / iOS 15"): The agent escalated it as a blocking bug, but the FAQ states the minimum is iOS 16 — so it's answerable.
- **E10** ("Maintenance tonight?"): The agent escalated because it didn't know tonight's schedule, but the FAQ says to point users to `status.roosterly.nl`.

**The fix**: Instead of hardcoding these two cases, I clarified the general policy: when the FAQ provides an official self-service resource (a status page, a roadmap link, a minimum-requirements explanation), that counts as a resolved answer, not a reason to escalate. The verifier was also updated to treat applying FAQ facts to a customer's situation as valid reasoning rather than hallucination.

**After fix**: 10/10 exact match (language, category, priority, and action all correct).

**Cost per 100 tickets**: \$0.51 USD (~€0.48 EUR), measured from actual `response.usage` token counts. The full 30-ticket practice run cost ~€0.14.

---

## What I would improve

1. **Retrieval for larger knowledge bases**: All 12 FAQ articles are loaded into the prompt, which works perfectly at this scale but wouldn't scale to 100+ articles. I'd add semantic retrieval (vector search + re-ranking) to keep prompts compact.
2. **Category disambiguation**: The gold labels put pricing questions under `billing` and other FAQ questions under `question`. A clearer mapping between FAQ articles and categories would remove this ambiguity.
