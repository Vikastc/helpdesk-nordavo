# Roosterly Helpdesk Support Agent

Autonomous AI support ticket triage and response agent for **Roosterly** (a Dutch shift-planning SaaS), built for the Nordavo Agentic AI Engineer take-home assessment.

---

## 1. How to run

### Prerequisites
* Node.js v20+ / v22+
* npm

### Setup from a fresh clone
```bash
git clone git@github.com:Vikastc/helpdesk-nordavo.git
cd helpdesk-nordavo
npm install
cp .env.example .env
```

Edit `.env` with your credentials:
```ini
HELPDESK_API_KEY=nrd_round_...
CANDIDATE_EMAIL=your_email@example.com
ANTHROPIC_API_KEY=sk-ant-...
LLM_MODEL=claude-haiku-5-5
```

### Commands
```bash
# Process all open tickets autonomously (the primary assignment command)
npm start

# Check live helpdesk status and local checkpoint state
npm run status

# Run accuracy evaluation against the 10 gold-standard examples
npm run eval

# Run all 37 automated unit & integration tests
npm test

# Dry-run classify a single ticket with Claude & guardrails
npx tsx src/main.ts classify T001 [--force]

# Reset practice tickets on the remote API
npm run reset
```

---

## 2. Decisions

1. **Architecture — Pure Functional TypeScript with OpenAI Structured Outputs**:
   * Pure functions and immutable data flows throughout; classes reserved solely for custom error types (`AlreadyHandledError`, `HelpdeskApiError`).
   * Powered by Anthropic Claude Haiku 5.5 via the OpenAI SDK (`@anthropic-ai/sdk` compatible `/v1` endpoint) using native structured JSON outputs (`chat.completions.parse` with `zodResponseFormat`).
2. **Dutch Language Strategy — Native Reply with Back-Translation Verification**:
   * Tickets are answered directly in the customer's language (mostly Dutch `nl`, sometimes `en` or `de`). Support handoff notes are strictly in English.
   * **Grounding Auditor**: For every generated draft reply, a second LLM step back-translates the text to English and audits every factual claim, link, and instruction against Roosterly's 12 FAQ points. If any hallucinated promise, incorrect URL, or ungrounded step is detected, the action automatically downgrades from `reply` to `handoff`.
3. **Defense-in-Depth Security**:
   * Pre-flight heuristic scanner detects prompt injections (<1ms, 0 tokens) and forces a `P1` security handoff.
   * Ticket contents are isolated inside `<untrusted_customer_ticket>` XML tags.
   * Deterministic safety-net rules override LLM decisions on refunds, cancellations, GDPR/AVG requests, security incidents, and legal threats.
4. **AI Tools Used**:
   * Built with Antigravity / Claude Code as an interactive pair-programming assistant for rapid test harness scaffolding, regex validation, and prompt calibration.
5. **Assumptions Made**:
   * Questions about planned maintenance (FAQ F11) are answered directly with the `status.roosterly.nl` link rather than escalated to a human for live schedule lookup (matching gold example `E10`).
   * App crashes on devices below minimum OS requirements (e.g. iOS 15 on iPhone 8) are categorized as `bug`, `P3`, and self-service resolved via FAQ F12 (matching gold example `E01`).

---

## 3. Reliability

* **503 Handling**: `requestWithResilience` uses exponential backoff with randomized jitter (base 500ms, max 8000ms, max 5 attempts) to absorb transient server outages without thundering herd issues.
* **429 Handling**: Built-in self-throttling rate limiter (4 requests/second, 250ms interval) guarantees requests stay safely below the 5 req/s ceiling. Dynamically respects `Retry-After` headers if returned.
* **409 & Crash Recovery (Idempotency)**:
  * Local checkpoint ledger `data/state.json` persists handled ticket IDs across restarts.
  * Before acting on any ticket, the agent verifies both local state and the remote API.
  * If the API returns a 409 conflict, `AlreadyHandledError` is caught, recorded in state, and safely skipped. Customers never receive duplicate answers.
* **Security & PII Redaction**:
  * Automated regex scrubber intercepts and redacts European IBANs (`NL..`) and 16-digit credit card numbers from all replies, handoff notes, and JSONL log files.
  * Secrets are strictly injected via environment variables; `.env` is gitignored.

---

## 4. Eval and fix

### Baseline Evaluation (Before Fix)
Running the initial evaluation harness on the 10 gold-standard examples (`GET /examples`) yielded an **8/10 (80.0%) Exact Match** score:
* **E01 ("App crashes")**: Misclassified as `handoff` (`P2`) because the agent treated crash reports as blocking software bugs needing engineering escalation, missing that FAQ F12 covers OS compatibility. The verifier also flagged stating minimum requirements as ungrounded causal diagnosis.
* **E10 ("Onderhoud")**: Misclassified as `handoff` because the agent believed it lacked tonight's specific maintenance calendar, failing to realize F11 prescribes directing users to `status.roosterly.nl`.

### The Fix Applied
Rather than hardcoding specific ticket edge cases (which would overfit to the 10 eval examples and fail to scale to 100+ tickets), we fixed the root policy definitions in the system prompts:
1. **Clarified Self-Service Resolution vs. Unresolved System Malfunction**: Explicitly defined that when the FAQ provides an official self-service resource (such as directing to a status portal or roadmap, or explaining that an environment is below documented minimum requirements), the issue is resolved via `reply` with priority `P3`. Truly unresolvable technical errors blocking users on supported setups remain `handoff` at `P2`.
2. **First-Principles Grounding in the Verifier**: Instructed the grounding auditor that applying documented FAQ premises to customer-stated facts (such as determining whether a customer's environment meets documented minimum requirements) is valid logical deduction rather than an ungrounded hallucination.

### Re-Evaluation (After Fix)
Re-running `npm run eval` achieved a **10/10 (100.0%) Exact Match** across all 10 examples:
* **Language Accuracy**: 10/10 (100.0%)
* **Action Accuracy**: 10/10 (100.0%)
* **Category Accuracy**: 10/10 (100.0%)
* **Priority Accuracy**: 10/10 (100.0%)
* **Exact Match**: 10/10 (100.0%)

### Cost per 100 Tickets (Empirical Calculation)
Measured directly from `response.usage` across all API calls on Claude 3.5 Haiku:
* **Measured Token Averages**: ~4,145 input tokens, ~436 output tokens per ticket.
* **Anthropic Pricing**: \$0.80 / 1M input tokens, \$4.00 / 1M output tokens.
* **Calculation**:
  $$\text{Cost per Ticket} = \left(\frac{4{,}145}{1{,}000{,}000} \times \$0.80\right) + \left(\frac{436}{1{,}000{,}000} \times \$4.00\right) = \$0.003316 + \$0.001744 = \mathbf{\$0.0051\text{ USD}}$$
  $$\text{Cost per 100 Tickets} = 100 \times \$0.0051 = \mathbf{\$0.51\text{ USD}\ (\approx €0.48\text{ EUR})}$$
* For the full 30-ticket practice run, total cost is **~€0.14 EUR**, well below the assignment budget of €1.00.

---

## 5. What I would improve

1. **Next Step — Hybrid RAG for Expanded Knowledge Bases**:
   * While loading all 12 FAQ articles directly into the prompt is fast and guarantees zero retrieval loss, scaling to 100+ articles would inflate input token costs. Implementing hybrid BM25 + dense vector semantic retrieval with re-ranking would maintain high accuracy while keeping prompts compact.
2. **Client Rule / Taxonomy Refinement**:
   * **Disambiguate `billing` vs `question`**: Tickets asking pricing questions (e.g. E07 *"What does Plus cost for 25 employees?"*) are labeled `billing` in the gold standard, while other FAQ inquiries are `question`. Formally defining a strict 1-to-1 mapping between FAQ articles and categories would eliminate human annotation ambiguity.
   * **Sentiment-Driven Priority Elevation**: Currently, all how-to questions are rated `P4`. Adding customer sentiment detection would enable automatically elevating an FAQ question to `P2` if the customer exhibits extreme frustration or churn risk.
