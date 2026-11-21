// src/main.ts — CLI entry point.

import { validateHelpdeskConfig } from "./config.js";
import * as client from "./client.js";

const commands: Record<string, () => Promise<void>> = {
  status: async () => {
    const s = await client.getStatus();
    console.log("\n📊 Helpdesk Status:");
    console.log(`   Mode:    ${s.mode}`);
    console.log(`   Open:    ${s.open_tickets}`);
    console.log(`   Handled: ${s.handled_tickets}\n`);
  },

  reset: async () => {
    console.log("🔄 Resetting practice tickets...");
    await client.resetPractice();
    console.log("✅ All tickets re-opened.\n");
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

  help: async () => {
    console.log(`
🐓 Roosterly Helpdesk Agent

Usage: npx tsx src/main.ts <command>

Commands:
  status    Show helpdesk status
  reset     Reset all practice tickets
  examples  Show the 10 labelled examples
  tickets   List all open tickets
  help      Show this message
    `);
  },
};

async function main() {
  const command = process.argv[2] ?? "help";

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
    await commands.help();
    process.exit(1);
  }

  await handler();
}

main().catch((err) => {
  console.error("💥 Fatal error:", err);
  process.exit(1);
});
