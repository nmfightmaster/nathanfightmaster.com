import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDigestEmail, digestWindow, summarize } from "../src/summary.js";
import { retentionFilters, runRetention } from "../src/retention.js";

const NOW = new Date("2026-11-23T16:00:00Z"); // a Monday, 8 AM Pacific
const window = digestWindow(NOW);
const cfg = { sender: "from@example.com", to: "to@example.com" };
const retention = { cutoffDay: "2026-08-25", visits: 3, claims: 7 };

function row(over) {
  return {
    ts: new Date("2026-11-20T18:00:00Z"),
    event: "view",
    tag: "",
    referrer: "",
    networkOrg: "Comcast Cable",
    countryCode: "US",
    visitorHash: "a".repeat(64),
    ...over,
  };
}

test("window covers the 7 days before now, by whole UTC days", () => {
  assert.equal(window.firstDay, "2026-11-16");
  assert.equal(window.lastDay, "2026-11-23");
  assert.equal(window.end - window.start, 7 * 86_400_000);
});

test("summarize trims to the window and counts unique visitors", () => {
  const rows = [
    row({}),
    row({ visitorHash: "b".repeat(64) }),
    row({ event: "pdf" }),
    row({ visitorHash: "" }), // no IP: counted as an event, not a visitor
    row({ ts: new Date("2026-11-16T15:59:59Z") }), // just before the window
    row({ ts: "2026-11-23T15:00:00Z" }), // string ts still parses
  ];
  const s = summarize(rows, window);
  assert.equal(s.total.views, 4);
  assert.equal(s.total.pdfs, 1);
  assert.equal(s.total.visitors.size, 2);
});

test("tagged rows group by tag; untagged by network, busiest first", () => {
  const rows = [
    row({ tag: "acme", networkOrg: "Microsoft Corporation" }),
    row({ tag: "acme", event: "pdf", ts: new Date("2026-11-21T01:00:00Z") }),
    row({ tag: "globex", ts: new Date("2026-11-22T01:00:00Z") }),
    row({ networkOrg: "Zayo" }),
    row({}),
    row({}),
    row({ networkOrg: "", countryCode: "" }),
  ];
  const s = summarize(rows, window);
  assert.deepEqual(s.tags.map(([t]) => t), ["globex", "acme"]); // most recent first
  const acme = s.tags.find(([t]) => t === "acme")[1];
  assert.equal(acme.views, 1);
  assert.equal(acme.pdfs, 1);
  assert.deepEqual([...acme.networks].sort(), ["Comcast Cable (US)", "Microsoft Corporation (US)"]);
  assert.deepEqual(
    s.networks.map(([n, c]) => [n, c.views]),
    [["Comcast Cable (US)", 2], ["(unknown network)", 1], ["Zayo (US)", 1]],
  );
});

test("referrers are reduced to host names", () => {
  const rows = [
    row({ referrer: "https://www.linkedin.com/jobs/view/123?x=1" }),
    row({ referrer: "https://www.linkedin.com/feed" }),
    row({ referrer: "not a url" }),
  ];
  assert.deepEqual(summarize(rows, window).referrers, [["www.linkedin.com", 2]]);
});

test("email has totals, sections and retention, and never the visitor hash", () => {
  const hash = "f".repeat(64);
  const s = summarize([row({ tag: "acme", visitorHash: hash }), row({ visitorHash: hash })], window);
  const msg = buildDigestEmail(s, window, retention, cfg);
  const body = msg.content.plainText;
  assert.equal(msg.senderAddress, cfg.sender);
  assert.deepEqual(msg.recipients.to, [{ address: cfg.to }]);
  assert.match(msg.content.subject, /^Resume weekly: 2 views, 0 PDF opens, 1 visitor \(/);
  assert.match(body, /TRACKED LINKS\n {2}acme: 1 view, 0 PDF opens, 1 visitor/);
  assert.match(body, /UNTAGGED, BY NETWORK\n {2}Comcast Cable \(US\): 1 view/);
  assert.match(body, /Deleted 3 visit rows from before 2026-08-25 and 7 alert claim rows/);
  assert.ok(!body.includes(hash.slice(0, 16)));
});

test("an empty week still sends, and a retention failure is reported", () => {
  const msg = buildDigestEmail(summarize([], window), window, { error: "RestError: boom" }, cfg);
  assert.match(msg.content.subject, /0 views, 0 PDF opens, 0 visitors/);
  assert.match(msg.content.plainText, /TRACKED LINKS\n {2}\(none\)/);
  assert.match(msg.content.plainText, /FAILED: RestError: boom/);
});

test("retention filters bound both partition ranges", () => {
  const f = retentionFilters(NOW);
  assert.equal(f.cutoffDay, "2026-08-25");
  assert.equal(f.visits, "PartitionKey ge '2000-01-01' and PartitionKey lt '2026-08-25'");
  assert.equal(f.claims, "PartitionKey ge 'alerts-' and PartitionKey lt 'alerts-2026-11-23'");
});

/** In-memory table that evaluates the two filter shapes runRetention uses. */
function fakeTable(keys) {
  const rows = new Set(keys.map(([p, r]) => `${p}|${r}`));
  const transactions = [];
  return {
    rows,
    transactions,
    async *listEntities({ queryOptions }) {
      const [, lo, hi] = queryOptions.filter.match(/ge '([^']*)' and PartitionKey lt '([^']*)'/);
      for (const k of [...rows]) {
        const [partitionKey, rowKey] = k.split("|");
        if (partitionKey >= lo && partitionKey < hi) yield { partitionKey, rowKey };
      }
    },
    async submitTransaction(actions) {
      const partitions = new Set(actions.map(([, e]) => e.partitionKey));
      assert.equal(partitions.size, 1, "a transaction must stay in one partition");
      assert.ok(actions.length <= 100);
      transactions.push(actions.length);
      for (const [op, e] of actions) {
        assert.equal(op, "delete");
        rows.delete(`${e.partitionKey}|${e.rowKey}`);
      }
    },
  };
}

test("retention deletes old days and old claim partitions only, in batches of 100", async () => {
  const old = Array.from({ length: 150 }, (_, i) => ["2026-08-01", `r${i}`]);
  const table = fakeTable([
    ...old,
    ["2026-08-24", "edge-old"],
    ["2026-08-25", "edge-kept"],
    ["2026-11-20", "recent"],
    ["alerts-2026-11-22", "cap_1"],
    ["alerts-2026-11-23", "cap_today"],
  ]);
  const result = await runRetention(table, NOW);
  assert.deepEqual(result, { cutoffDay: "2026-08-25", visits: 151, claims: 1, dryRun: false });
  assert.deepEqual([...table.rows].sort(), [
    "2026-08-25|edge-kept",
    "2026-11-20|recent",
    "alerts-2026-11-23|cap_today",
  ]);
  assert.deepEqual(table.transactions.sort((a, b) => a - b), [1, 1, 50, 100]);
});

test("dry run counts without deleting", async () => {
  const table = fakeTable([["2026-01-01", "a"], ["alerts-2026-01-01", "b"]]);
  const result = await runRetention(table, NOW, { dryRun: true });
  assert.equal(result.visits, 1);
  assert.equal(result.claims, 1);
  assert.equal(table.rows.size, 2);
  assert.equal(table.transactions.length, 0);
});
