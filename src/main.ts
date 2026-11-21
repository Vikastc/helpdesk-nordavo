// src/main.ts — Functional CLI entry point.

import { validateHelpdeskConfig, validateFullConfig } from "./config.js";
import * as client from "./client.js";
import { resetLocalState, loadState } from "./state.js";
import { classifyTicket } from "./classifier.js";

const commands: Record<string, (args: string[]) => Promise<void>> = {
  status: async () => {
    const s = await client.getStatus();
    const localState = loadState();
    const localHandledCount = Object.keys(localState.handled_tickets).length;

    console.log("\n📊 Helpdesk Status:");
    console.log(`   Mode:          ${s.mode}`);
    console.log(`   Open:          ${s.open_tickets}`);
    console.log(`   Handled (API): ${s.handled_tickets}`);
    console.log(`   Handled (Loc): ${localHandledCount}`);
    console.log(`   Current RunId: ${localState.run_id}\n`);
  },

  reset: async () => {
    console.log("🔄 Resetting practice tickets on Helpdesk API...");
    const res = await client.resetPractice();
    resetLocalState();
    console.log(`✅ Re-opened ${res.reopened_tickets} tickets. Local state reset.\n`);
  },

  examples: async () => {
    const examples = await client.getExamples();
    console.log(`\n📋 ${examples.length} labelled examples:\n`);
    for (const ex of examples) {
      console.log(
        `  ${ex.id}: [${ex.label.action}] ${ex.label.category} ${ex.label.priority} — ${ex.subject}`
      );
      console.log(`        Reason: ${ex.label.reason}\n`);
    }
  },

  tickets: async () => {
    const tickets = await client.getAllOpenTickets();
    console.log(`\n📥 ${tickets.length} open tickets:\n`);
    for (const t of tickets) {
      console.log(`  ${t.id}: ${t.subject}`);
      console.log(`        Plan: ${t.customer_plan} | Channel: ${t.channel}`);
      console.log(`        ${t.body.substring(0, 100)}...\n`);
    }
  },

  ticket: async (args: string[]) => {
    const id = args[0];
    if (!id) {
      console.error("❌ Please provide a ticket ID (e.g. npx tsx src/main.ts ticket T001)");
      return;
    }
    const t = await client.getTicket(id);
    console.log(`\n🎫 Ticket ${t.id}:`);
    console.log(`   Subject:  ${t.subject}`);
    console.log(`   Plan:     ${t.customer_plan}`);
    console.log(`   Channel:  ${t.channel}`);
    console.log(`   Received: ${t.received_at}`);
    console.log(`   Handled:  ${t.status ?? "unhandled"}`);
    console.log(`\n   Body:\n   ${t.body}\n`);
  },

  classify: async (args: string[]) => {
    validateFullConfig();
    const id = args[0];
    if (!id) {
      console.error("❌ Please provide a ticket ID (e.g. npx tsx src/main.ts classify T001)");
      return;
    }
    const t = await client.getTicket(id);
    console.log(`\n🤖 Classifying Ticket ${t.id} with Claude...`);
    console.log(`   Subject: "${t.subject}"`);
    console.log(`   Body:    "${t.body}"\n`);
    const decision = await classifyTicket(t);
    console.log("📋 Decision Result:");
    console.log(JSON.stringify(decision, null, 2));
    console.log("");
  },

  help: async () => {
    console.log(`
🐓 Roosterly Helpdesk Agent

Usage: npx tsx src/main.ts <command> [args]

Commands:
  status        Show helpdesk & local state status
  reset         Reset all practice tickets & clear local state
  examples      Show the 10 labelled examples
  tickets       List all open tickets
  ticket <id>     Inspect a single ticket by ID
  classify <id>   Classify a ticket with Claude & guardrails (dry run)
  help            Show this message
    `);
  },
};

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";
  const commandArgs = args.slice(1);

  try {
    validateHelpdeskConfig();
  } catch (err) {
    console.error(`❌ Config error: ${err}`);
    console.error("   Check your .env file (see .env.example)");
    process.exit(1);
  }

  const handler = commands[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    await commands.help([]);
    process.exit(1);
  }

  await handler(commandArgs);
}

main().catch((err) => {
  console.error("💥 Fatal error:", err);
  process.exit(1);
});
