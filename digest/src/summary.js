// Weekly digest content: a rolling 7 days of visit rows,
// grouped by tracked tag, then untagged traffic by network owner. Pure functions only, so the
// whole email can be tested without Azure.
// Rows never contain a raw IP (see api/src/lib/visit.js). The visitor hash is used only to count
// unique visitors and never appears in the email.

export const WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;
const TIME_ZONE = "America/Los_Angeles";
const MAX_NETWORKS = 25;
const MAX_REFERRERS = 10;

/** UTC day string `YYYY-MM-DD`, the visit-row PartitionKey format. */
export function utcDay(date) {
  return date.toISOString().slice(0, 10);
}

/** The digest window [start, end) and the partition range that covers it. */
export function digestWindow(now, days = WINDOW_DAYS) {
  const start = new Date(now.getTime() - days * DAY_MS);
  return { start, end: now, firstDay: utcDay(start), lastDay: utcDay(now) };
}

function emptyCounts() {
  return { views: 0, pdfs: 0, visitors: new Set(), last: null };
}

function add(counts, row) {
  if (row.event === "pdf") counts.pdfs += 1;
  else counts.views += 1;
  if (row.visitorHash) counts.visitors.add(row.visitorHash);
  if (!counts.last || row.ts > counts.last) counts.last = row.ts;
}

function networkLabel(row) {
  if (!row.networkOrg) return "(unknown network)";
  return row.countryCode ? `${row.networkOrg} (${row.countryCode})` : row.networkOrg;
}

function referrerHost(referrer) {
  if (!referrer) return null;
  try {
    return new URL(referrer).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Totals and groups for the rows whose ts falls in [start, end). Rows outside the window (the
 * partition query is by whole UTC day) are ignored.
 */
export function summarize(rows, { start, end }) {
  const total = emptyCounts();
  const tags = new Map();
  const networks = new Map();
  const referrers = new Map();
  for (const raw of rows) {
    const ts = raw.ts instanceof Date ? raw.ts : new Date(raw.ts);
    if (Number.isNaN(ts.getTime()) || ts < start || ts >= end) continue;
    const row = { ...raw, ts };
    add(total, row);
    if (row.tag) {
      if (!tags.has(row.tag)) tags.set(row.tag, { ...emptyCounts(), networks: new Set() });
      const t = tags.get(row.tag);
      add(t, row);
      t.networks.add(networkLabel(row));
    } else {
      const label = networkLabel(row);
      if (!networks.has(label)) networks.set(label, emptyCounts());
      add(networks.get(label), row);
    }
    const host = referrerHost(row.referrer);
    if (host) referrers.set(host, (referrers.get(host) ?? 0) + 1);
  }
  const byActivity = (a, b) => b[1].views + b[1].pdfs - (a[1].views + a[1].pdfs) || (a[0] < b[0] ? -1 : 1);
  return {
    total,
    // Most recently seen tag first: the ones still in play are at the top.
    tags: [...tags].sort((a, b) => b[1].last - a[1].last),
    networks: [...networks].sort(byActivity),
    referrers: [...referrers].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
  };
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function countsText(c) {
  return `${plural(c.views, "view")}, ${plural(c.pdfs, "PDF open")}, ${plural(c.visitors.size, "visitor")}`;
}

const dateFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  weekday: "short",
  month: "short",
  day: "numeric",
});
const timeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

/**
 * The digest email. `retention` is the result of the retention run, or { error } if it failed.
 * Plain text only, so referrers and network names need no escaping.
 */
export function buildDigestEmail(summary, { start, end }, retention, { sender, to }) {
  const { total } = summary;
  const range = `${dateFmt.format(start)} – ${dateFmt.format(end)}`;
  const lines = [`Resume visits, ${range} (Pacific)`, "", `Total: ${countsText(total)}`, ""];

  lines.push("TRACKED LINKS");
  if (summary.tags.length === 0) lines.push("  (none)");
  for (const [tag, c] of summary.tags) {
    lines.push(`  ${tag}: ${countsText(c)}`);
    lines.push(`    last seen ${timeFmt.format(c.last)}`);
    lines.push(`    networks: ${[...c.networks].sort().join("; ")}`);
  }
  lines.push("");

  lines.push("UNTAGGED, BY NETWORK");
  if (summary.networks.length === 0) lines.push("  (none)");
  for (const [label, c] of summary.networks.slice(0, MAX_NETWORKS)) {
    lines.push(`  ${label}: ${countsText(c)}`);
  }
  if (summary.networks.length > MAX_NETWORKS) {
    lines.push(`  …and ${plural(summary.networks.length - MAX_NETWORKS, "more network")}`);
  }
  lines.push("");

  lines.push("REFERRERS");
  if (summary.referrers.length === 0) lines.push("  (none)");
  for (const [host, n] of summary.referrers.slice(0, MAX_REFERRERS)) {
    lines.push(`  ${host}: ${n}`);
  }
  lines.push("");

  lines.push("RETENTION");
  if (retention.error) {
    lines.push(`  FAILED: ${retention.error}. Rows past 90 days were not deleted; check the workflow run.`);
  } else {
    lines.push(
      `  ${retention.dryRun ? "Would delete" : "Deleted"} ${plural(retention.visits, "visit row")} from before ${retention.cutoffDay} and ` +
        `${plural(retention.claims, "alert claim row")}.`,
    );
  }

  return {
    senderAddress: sender,
    recipients: { to: [{ address: to }] },
    content: {
      subject: `Resume weekly: ${countsText(total)} (${range})`,
      plainText: lines.join("\n"),
    },
  };
}
