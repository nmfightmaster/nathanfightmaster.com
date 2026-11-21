// POST /api/visit: the page's analytics beacon. Logic lives in ../lib/visit.js.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { app } from "@azure/functions";
import { TableClient } from "@azure/data-tables";
import { EmailClient } from "@azure/communication-email";
import { Reader } from "mmdb-lib";
import { createHandler, readConfig } from "../lib/visit.js";

// IPinfo Lite (CC BY-SA 4.0, https://ipinfo.io/lite). Not committed: the deploy workflow
// downloads it into api/data/ before upload. If it is missing, rows are stored without
// country/network fields.
const DB_PATH = fileURLToPath(new URL("../../data/ipinfo_lite.mmdb", import.meta.url));

let lookup; // undefined = not loaded yet; null = database missing
function getLookup() {
  if (lookup === undefined) {
    try {
      const reader = new Reader(readFileSync(DB_PATH));
      lookup = (ip) => reader.get(ip);
    } catch {
      lookup = null;
      console.warn("visit: IP database not found; storing rows without enrichment");
    }
  }
  return lookup;
}

let table;
function getTable(config) {
  table ??= TableClient.fromConnectionString(config.connectionString, config.table);
  return table;
}

let mailer;
function getMailer(alertConfig) {
  mailer ??= new EmailClient(alertConfig.connectionString);
  return mailer;
}

app.http("visit", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "visit",
  handler: createHandler({ getConfig: () => readConfig(process.env), getTable, getLookup, getMailer }),
});
