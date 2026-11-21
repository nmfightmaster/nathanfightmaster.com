// Logic for POST /api/visit, kept free of Azure bindings so it can be unit-tested.
// Rules (logging is minimal and purpose-limited):
//   - The raw IP is never stored or logged. It is looked up in the bundled database, then kept
//     only as an HMAC-SHA256 with IP_HASH_SALT (for counting unique visitors).
//   - Bots are dropped. Nothing is stored for them.
//   - Without app settings (preview environments, local runs) the function stores nothing.
//   - The response is always 204: the beacon is fire-and-forget and never learns the outcome.
//   - Tagged rows also send an instant alert email (./alert.js); it can't change the 204.

import { createHmac, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { readAlertConfig, sendAlert } from "./alert.js";

export const EVENTS = new Set(["view", "pdf"]);
const MAX_BODY = 2048;
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

// Crawlers, link unfurlers, monitors, scripted clients and headless browsers. Most of these never
// run the page's JS, but some (headless Chrome, preview renderers) do. Deliberately not matched:
// app names like Slack or Teams, whose in-app browsers are real people.
const BOT_RE =
  /bot\b|bot\/|crawl|spider|slurp|scrap|headless|phantom|puppeteer|playwright|selenium|lighthouse|pagespeed|gtmetrix|pingdom|uptime|preview|unfurl|facebookexternalhit|meta-externalagent|curl|wget|httpie|python|java\/|okhttp|go-http|axios|node-fetch|undici|libwww|http[-_ ]?client|postman|insomnia/i;

export function isBot(userAgent) {
  return !userAgent || BOT_RE.test(userAgent);
}

/** First hop of x-forwarded-for, without a port. Returns null unless it is a valid IP. */
export function clientIp(forwardedFor) {
  if (!forwardedFor) return null;
  let ip = forwardedFor.split(",")[0].trim();
  const bracketed = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) ip = bracketed[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(":"));
  return isIP(ip) ? ip : null;
}

export function hashIp(ip, salt) {
  return createHmac("sha256", salt).update(ip).digest("hex");
}

function clip(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/**
 * Reads the body as UTF-8, stopping as soon as it passes `max` bytes (returns null then).
 * Content-Length alone isn't enough: a chunked request has none.
 */
export async function readCapped(request, max = MAX_BODY) {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Validates the beacon body. Returns null for anything malformed. */
export function parsePayload(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_BODY) return null;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || !EVENTS.has(body.event)) return null;
  const path = clip(body.path, 200);
  const tag = clip(body.tag, 40).toLowerCase();
  return {
    event: body.event,
    path: path.startsWith("/") ? path : "/",
    referrer: clip(body.referrer, 500),
    tag: TAG_RE.test(tag) ? tag : "",
  };
}

/** Country + network owner from an IPinfo Lite record. Empty strings when unknown. */
export function enrich(lookup, ip) {
  let record = null;
  try {
    record = ip && lookup ? lookup(ip) : null;
  } catch {
    record = null;
  }
  return {
    country: clip(record?.country, 100),
    countryCode: clip(record?.country_code, 2),
    asn: clip(record?.asn, 20),
    networkOrg: clip(record?.as_name, 200),
  };
}

/**
 * One row per event. PartitionKey is the UTC day, so the digest can query a week and the
 * retention job can delete whole days. RowKey sorts by time within the day.
 */
export function buildEntity({ payload, userAgent, ip, salt, lookup, now }) {
  const iso = now.toISOString();
  return {
    partitionKey: iso.slice(0, 10),
    rowKey: `${iso}_${randomUUID().slice(0, 8)}`,
    ts: now,
    event: payload.event,
    path: payload.path,
    referrer: payload.referrer,
    tag: payload.tag,
    userAgent: clip(userAgent, 500),
    ...enrich(lookup, ip),
    visitorHash: ip ? hashIp(ip, salt) : "",
  };
}

/**
 * Settings the function needs. Returns null if a storage setting is missing, which turns
 * logging off. `alert` is null if an email setting is missing, which turns only alerts off.
 */
export function readConfig(env) {
  const connectionString = env.STORAGE_CONNECTION_STRING;
  const table = env.VISITS_TABLE;
  const salt = env.IP_HASH_SALT;
  if (!(connectionString && table && salt)) return null;
  return { connectionString, table, salt, alert: readAlertConfig(env) };
}

/**
 * Builds the HTTP handler. Dependencies are injected so tests can run without Azure:
 *   getConfig()     -> readConfig result or null
 *   getTable(cfg)   -> object with createEntity(entity)
 *   getLookup()     -> (ip) => IPinfo record | null, or null if the database is missing
 *   getMailer(acfg) -> object with beginSend(message, options) (ACS EmailClient)
 */
export function createHandler({ getConfig, getTable, getLookup, getMailer, now = () => new Date() }) {
  const done = { status: 204 };
  return async function visit(request, context) {
    try {
      const config = getConfig();
      if (!config) return done;

      const userAgent = request.headers.get("user-agent") ?? "";
      if (isBot(userAgent)) return done;

      const payload = parsePayload(await readCapped(request));
      if (!payload) return done;

      const ip = clientIp(request.headers.get("x-forwarded-for"));
      const time = now();
      const entity = buildEntity({
        payload,
        userAgent,
        ip,
        salt: config.salt,
        lookup: getLookup(),
        now: time,
      });
      const table = getTable(config);
      // The alert runs alongside the write; sendAlert never throws, so only a storage error
      // reaches the catch below.
      await Promise.all([
        table.createEntity(entity),
        sendAlert({ entity, alertConfig: config.alert, table, getMailer, now: time, context }),
      ]);
    } catch (err) {
      // Never include request data here: the message is generic and carries no IP.
      context.error(`visit: failed to record event: ${err?.name ?? "Error"}: ${err?.message ?? ""}`);
    }
    return done;
  };
}
