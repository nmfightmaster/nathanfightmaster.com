// Weekly digest + retention job, run by .github/workflows/weekly-digest.yml.
// Auth is Entra ID (OIDC in CI via azure/login, or a local `az login`), so no keys are needed.
//
// Settings (env): TABLES_ENDPOINT, VISITS_TABLE, ACS_ENDPOINT, EMAIL_SENDER, DIGEST_TO.
// Flags:
//   --dry-run  counts expired rows without deleting them, and prints the email instead of sending
//              it (the body only outside CI).
//
// Order: read the week, run retention, then send. The two don't overlap (7 days vs 90), and the
// email reports a retention failure instead of being skipped. Exits 1 if anything failed, so
// GitHub emails the repo owner about the failed run.

import { DefaultAzureCredential } from "@azure/identity";
import { TableClient, odata } from "@azure/data-tables";
import { EmailClient } from "@azure/communication-email";
import { buildDigestEmail, digestWindow, summarize } from "./summary.js";
import { runRetention } from "./retention.js";

const SETTINGS = ["TABLES_ENDPOINT", "VISITS_TABLE", "ACS_ENDPOINT", "EMAIL_SENDER", "DIGEST_TO"];

function readSettings(env) {
  const missing = SETTINGS.filter((k) => !env[k]);
  if (missing.length) throw new Error(`missing settings: ${missing.join(", ")}`);
  return Object.fromEntries(SETTINGS.map((k) => [k, env[k]]));
}

async function readWeek(table, window) {
  // Whole UTC days covering the window; summarize() trims to the exact 7 days by ts. The upper
  // bound excludes the `alerts-` partitions, which sort after every day.
  const filter = odata`PartitionKey ge ${window.firstDay} and PartitionKey le ${window.lastDay}`;
  const rows = [];
  for await (const e of table.listEntities({ queryOptions: { filter } })) rows.push(e);
  return rows;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const s = readSettings(process.env);
  const credential = new DefaultAzureCredential();
  const table = new TableClient(s.TABLES_ENDPOINT, s.VISITS_TABLE, credential);
  const now = new Date();
  const window = digestWindow(now);
  let failed = false;

  const rows = await readWeek(table, window);
  const summary = summarize(rows, window);
  console.log(`digest: ${rows.length} rows read for ${window.firstDay}..${window.lastDay}`);

  let retention;
  try {
    retention = await runRetention(table, now, { dryRun });
    const verb = dryRun ? "would delete" : "deleted";
    console.log(`retention: ${verb} ${retention.visits} visit rows (before ${retention.cutoffDay}), ${retention.claims} claim rows`);
  } catch (err) {
    failed = true;
    retention = { error: `${err?.name ?? "Error"}: ${err?.message ?? ""}` };
    console.error(`retention failed: ${retention.error}`);
  }

  const message = buildDigestEmail(summary, window, retention, { sender: s.EMAIL_SENDER, to: s.DIGEST_TO });
  if (dryRun) {
    // The body names networks and referrers, which must not land in CI logs (visitor data goes
    // nowhere but Nathan's email). Only local dry runs print it.
    const body = process.env.CI ? "(body not printed in CI)" : message.content.plainText;
    console.log(`\n--- dry run: email not sent ---\nSubject: ${message.content.subject}\n\n${body}`);
  } else {
    const poller = await new EmailClient(s.ACS_ENDPOINT, credential).beginSend(message);
    const result = await poller.pollUntilDone();
    console.log(`email: ${result.status}`);
    if (result.status !== "Succeeded") failed = true;
  }

  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`digest failed: ${err?.name ?? "Error"}: ${err?.message ?? ""}`);
  process.exitCode = 1;
});
