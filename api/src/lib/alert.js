// Instant alert email for tagged visits.
// Rules:
//   - Built only from the stored row: the raw IP never reaches this module, and the visitor
//     hash is not included in the email.
//   - Throttled, because anyone can type any tag and ACS's managed domain allows only 10
//     emails/hour for the whole subscription (shared with the weekly digest):
//       * one alert per tag + visitor + event per 30 minutes (reloads don't re-alert, but a view
//         followed by a PDF click still sends two), and
//       * at most ALERTS_PER_HOUR alerts per UTC hour in total.
//     Both limits are claim rows in the visits table. createEntity is atomic (409 if the row
//     exists), so the limits hold across function instances without a read-then-write race.
//   - Never throws to the caller and never changes the beacon's 204.

export const ALERTS_PER_HOUR = 4;
const DEDUPE_MINUTES = 30;
const SEND_TIMEOUT_MS = 5000;
const TIME_ZONE = "America/Los_Angeles";

/** Email settings. Returns null if any is missing, which turns alerts off (rows still store). */
export function readAlertConfig(env) {
  const connectionString = env.ACS_CONNECTION_STRING;
  const sender = env.EMAIL_SENDER;
  const to = env.ALERT_TO;
  return connectionString && sender && to ? { connectionString, sender, to } : null;
}

/**
 * Claim-row partition for a UTC day: `alerts-YYYY-MM-DD`. It sorts after the visit partitions
 * (`YYYY-…`), so a digest range query over days never sees it; the retention job deletes it by
 * the same date.
 */
export function alertPartition(now) {
  return `alerts-${now.toISOString().slice(0, 10)}`;
}

export function dedupeKey(entity, now) {
  const bucket = Math.floor(now.getTime() / (DEDUPE_MINUTES * 60_000));
  const visitor = entity.visitorHash ? entity.visitorHash.slice(0, 16) : "noip";
  return `dedupe_${entity.tag}_${entity.event}_${visitor}_${bucket}`;
}

export function capKeys(now) {
  const hour = now.toISOString().slice(0, 13); // YYYY-MM-DDTHH
  return Array.from({ length: ALERTS_PER_HOUR }, (_, i) => `cap_${hour}_${i + 1}`);
}

/** true if this call created the row; false if it already existed. Other errors propagate. */
async function claim(table, partitionKey, rowKey) {
  try {
    await table.createEntity({ partitionKey, rowKey });
    return true;
  } catch (err) {
    if (err?.statusCode === 409) return false;
    throw err;
  }
}

/** "dedupe" | "cap" if throttled, null if this alert may send. */
export async function claimAlert(table, entity, now) {
  const partitionKey = alertPartition(now);
  if (!(await claim(table, partitionKey, dedupeKey(entity, now)))) return "dedupe";
  for (const rowKey of capKeys(now)) {
    if (await claim(table, partitionKey, rowKey)) return null;
  }
  return "cap";
}

function formatTime(date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

/** The ACS EmailMessage for one row. Plain text only. */
export function buildAlertEmail(entity, { sender, to }) {
  const action = entity.event === "pdf" ? "opened the PDF" : "viewed the resume";
  const network = entity.networkOrg
    ? `${entity.networkOrg}${entity.asn ? ` (${entity.asn})` : ""}`
    : "(unknown)";
  const lines = [
    `Tag: ${entity.tag}`,
    `Event: ${entity.event === "pdf" ? "PDF download" : "page view"}`,
    `Time: ${formatTime(entity.ts)} (${entity.ts.toISOString()})`,
    `Country: ${entity.country || "(unknown)"}`,
    `Network: ${network}`,
    `Referrer: ${entity.referrer || "(none)"}`,
    `User agent: ${entity.userAgent || "(none)"}`,
    "",
    "Tags are typed into the URL, so anyone can send any tag. Repeat hits from the same visitor within 30 minutes, and anything past 4 alerts an hour, appear only in the weekly digest.",
  ];
  return {
    senderAddress: sender,
    recipients: { to: [{ address: to }] },
    // The tag is already limited to [a-z0-9-], so it is safe in a subject line.
    content: { subject: `Resume: "${entity.tag}" ${action}`, plainText: lines.join("\n") },
  };
}

/**
 * Sends the alert for a stored row if it has a tag and isn't throttled.
 *   table     -> object with createEntity (the visits table)
 *   getMailer -> (alertConfig) => object with beginSend(message, { abortSignal })
 * Awaiting beginSend makes only the initial request (ACS queues the email); delivery is not
 * polled. Returns what happened, for tests and logs.
 */
export async function sendAlert({ entity, alertConfig, table, getMailer, now, context }) {
  if (!entity.tag || !alertConfig) return "skipped";
  try {
    const throttled = await claimAlert(table, entity, now);
    if (throttled) return throttled;
    const message = buildAlertEmail(entity, alertConfig);
    await getMailer(alertConfig).beginSend(message, {
      abortSignal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    return "sent";
  } catch (err) {
    // Generic message only: no visitor data.
    context.error(`visit: alert failed: ${err?.name ?? "Error"}: ${err?.message ?? ""}`);
    return "failed";
  }
}
