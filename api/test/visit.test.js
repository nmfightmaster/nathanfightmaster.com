import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEntity,
  clientIp,
  createHandler,
  hashIp,
  isBot,
  parsePayload,
  readCapped,
  readConfig,
} from "../src/lib/visit.js";
import { ALERTS_PER_HOUR, buildAlertEmail, readAlertConfig } from "../src/lib/alert.js";

const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const IPINFO = { country: "United States", country_code: "US", asn: "AS8075", as_name: "Microsoft Corporation" };

test("clientIp takes the first hop and strips ports", () => {
  assert.equal(clientIp("203.0.113.7"), "203.0.113.7");
  assert.equal(clientIp("203.0.113.7:51234, 10.0.0.1"), "203.0.113.7");
  assert.equal(clientIp("2001:db8::1"), "2001:db8::1");
  assert.equal(clientIp("[2001:db8::1]:443"), "2001:db8::1");
  assert.equal(clientIp("not-an-ip"), null);
  assert.equal(clientIp(null), null);
});

test("isBot drops crawlers, scripts, headless browsers and empty agents", () => {
  for (const ua of [
    "",
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0)",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/131.0.0.0 Safari/537.36",
    "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
    "curl/8.5.0",
    "python-requests/2.32.3",
    "Mozilla/5.0 (compatible; Chrome-Lighthouse)",
  ]) {
    assert.equal(isBot(ua), true, ua);
  }
  assert.equal(isBot(CHROME), false);
  assert.equal(
    isBot("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1"),
    false,
  );
});

test("parsePayload validates event, path and tag", () => {
  assert.deepEqual(parsePayload('{"event":"view","path":"/","referrer":"https://www.linkedin.com/","tag":"Acme"}'), {
    event: "view",
    path: "/",
    referrer: "https://www.linkedin.com/",
    tag: "acme",
  });
  assert.equal(parsePayload('{"event":"click"}'), null);
  assert.equal(parsePayload("not json"), null);
  assert.equal(parsePayload(""), null);
  assert.equal(parsePayload("x".repeat(5000)), null);
  const odd = parsePayload('{"event":"pdf","path":"javascript:x","tag":"<script>","referrer":5}');
  assert.deepEqual(odd, { event: "pdf", path: "/", referrer: "", tag: "" });
});

test("readConfig requires all three storage settings; alerts need all three email settings", () => {
  const storage = { STORAGE_CONNECTION_STRING: "x", VISITS_TABLE: "visits", IP_HASH_SALT: "s" };
  const email = { ACS_CONNECTION_STRING: "acs", EMAIL_SENDER: "from@x", ALERT_TO: "to@x" };
  assert.equal(readConfig({}), null);
  assert.equal(readConfig({ STORAGE_CONNECTION_STRING: "x", VISITS_TABLE: "visits" }), null);
  assert.equal(readConfig(email), null);
  assert.deepEqual(readConfig(storage), { connectionString: "x", table: "visits", salt: "s", alert: null });
  assert.deepEqual(readConfig({ ...storage, ...email }).alert, { connectionString: "acs", sender: "from@x", to: "to@x" });
  assert.equal(readAlertConfig({ ...email, ALERT_TO: "" }), null);
});

test("readCapped stops reading a chunked body once it passes the cap", async () => {
  let pulls = 0;
  let cancelled = false;
  const endless = new ReadableStream({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const req = new Request("http://x/api/visit", { method: "POST", body: endless, duplex: "half" });
  assert.equal(req.headers.get("content-length"), null);
  assert.equal(await readCapped(req, 2048), null);
  assert.ok(pulls <= 4, `read ${pulls} chunks`);
  assert.ok(cancelled);

  assert.equal(await readCapped(new Request("http://x", { method: "POST", body: "héllo" })), "héllo");
  assert.equal(await readCapped(new Request("http://x", { method: "POST" })), "");
  const declared = new Request("http://x", { method: "POST", body: "{}", headers: { "content-length": "99999" } });
  assert.equal(await readCapped(declared), null);
});

test("buildEntity enriches, hashes, and never stores the raw IP", () => {
  const ip = "203.0.113.7";
  const entity = buildEntity({
    payload: { event: "view", path: "/", referrer: "", tag: "acme" },
    userAgent: CHROME,
    ip,
    salt: "salt",
    lookup: () => IPINFO,
    now: new Date("2026-11-20T18:30:00.000Z"),
  });
  assert.equal(entity.partitionKey, "2026-11-20");
  assert.match(entity.rowKey, /^2026-11-20T18:30:00\.000Z_[0-9a-f]{8}$/);
  assert.equal(entity.country, "United States");
  assert.equal(entity.countryCode, "US");
  assert.equal(entity.asn, "AS8075");
  assert.equal(entity.networkOrg, "Microsoft Corporation");
  assert.equal(entity.visitorHash, hashIp(ip, "salt"));
  assert.notEqual(hashIp(ip, "salt"), hashIp(ip, "other-salt"));
  assert.ok(!JSON.stringify(entity).includes(ip), "raw IP leaked into the row");
});

test("buildEntity tolerates a missing database or a failed lookup", () => {
  const base = { payload: { event: "pdf", path: "/", referrer: "", tag: "" }, userAgent: CHROME, salt: "s", now: new Date() };
  for (const lookup of [null, () => null, () => { throw new Error("bad"); }]) {
    const entity = buildEntity({ ...base, ip: "203.0.113.7", lookup });
    assert.equal(entity.country, "");
    assert.equal(entity.networkOrg, "");
    assert.equal(entity.visitorHash.length, 64);
  }
  assert.equal(buildEntity({ ...base, ip: null, lookup: null }).visitorHash, "");
});

// --- handler ---

function request({ body = '{"event":"view","path":"/"}', ua = CHROME, xff = "203.0.113.7:5000" } = {}) {
  const headers = new Headers({ "user-agent": ua, "content-type": "text/plain;charset=UTF-8" });
  if (xff) headers.set("x-forwarded-for", xff);
  return new Request("http://x/api/visit", { method: "POST", headers, body });
}

const tagged = (tag, event = "view") => request({ body: JSON.stringify({ event, path: "/", tag }) });
const ALERT = { connectionString: "acs", sender: "DoNotReply@x.azurecomm.net", to: "me@example.com" };
const CONFIG = { connectionString: "x", table: "visits", salt: "s", alert: ALERT };

function harness({ config = CONFIG, fail = false, mailFail = false } = {}) {
  const store = new Map(); // "pk|rk" -> entity; duplicates throw 409 like Table Storage
  const sent = [];
  const errors = [];
  let clock = new Date("2026-11-20T18:30:00.000Z");
  const handler = createHandler({
    getConfig: () => config,
    getTable: () => ({
      createEntity: async (e) => {
        if (fail) throw new Error("table down");
        const key = `${e.partitionKey}|${e.rowKey}`;
        if (store.has(key)) throw Object.assign(new Error("EntityAlreadyExists"), { statusCode: 409 });
        store.set(key, e);
      },
    }),
    getLookup: () => () => IPINFO,
    getMailer: () => ({
      beginSend: async (message, options) => {
        assert.ok(options.abortSignal, "send must be bounded by a timeout");
        if (mailFail) throw new Error("ACS 429");
        sent.push(message);
      },
    }),
    now: () => clock,
  });
  const context = { error: (msg) => errors.push(msg) };
  // Visit rows only; alert claim rows live in alerts-* partitions.
  const rows = () => [...store.values()].filter((e) => !e.partitionKey.startsWith("alerts-"));
  return {
    rows,
    sent,
    errors,
    advance: (minutes) => (clock = new Date(clock.getTime() + minutes * 60_000)),
    call: (req) => handler(req, context),
  };
}

test("handler writes one row for a real visit", async () => {
  const h = harness();
  assert.deepEqual(await h.call(request()), { status: 204 });
  assert.equal(h.rows().length, 1);
  assert.equal(h.rows()[0].networkOrg, "Microsoft Corporation");
  assert.equal(h.sent.length, 0, "untagged visits don't alert");
});

test("handler is a no-op without settings, for bots, and for bad bodies", async () => {
  const off = harness({ config: null });
  await off.call(request());
  assert.equal(off.rows().length, 0);

  const h = harness();
  await h.call(request({ ua: "Googlebot/2.1" }));
  await h.call(request({ body: "{}" }));
  await h.call(request({ body: "garbage" }));
  assert.equal(h.rows().length, 0);
});

test("handler swallows storage errors and logs no IP", async () => {
  const h = harness({ fail: true });
  assert.deepEqual(await h.call(request()), { status: 204 });
  assert.equal(h.errors.length, 1);
  assert.ok(!h.errors[0].includes("203.0.113.7"));
});

// --- alerts ---

test("a tagged visit stores the row and sends one alert with no IP or hash", async () => {
  const h = harness();
  assert.deepEqual(await h.call(tagged("acme")), { status: 204 });
  assert.equal(h.rows().length, 1);
  assert.equal(h.sent.length, 1);
  const [mail] = h.sent;
  assert.equal(mail.senderAddress, ALERT.sender);
  assert.deepEqual(mail.recipients, { to: [{ address: "me@example.com" }] });
  assert.equal(mail.content.subject, 'Resume: "acme" viewed the resume');
  const text = mail.content.plainText;
  for (const want of [
    "Tag: acme",
    "Event: page view",
    "Country: United States",
    "Network: Microsoft Corporation (AS8075)",
    "Referrer: (none)",
    "10:30 AM PST",
    CHROME,
  ]) {
    assert.ok(text.includes(want), `missing ${want}`);
  }
  const all = JSON.stringify(mail);
  assert.ok(!all.includes("203.0.113.7"), "raw IP in email");
  assert.ok(!all.includes(h.rows()[0].visitorHash.slice(0, 16)), "visitor hash in email");
});

test("alerts dedupe per tag + visitor + event for 30 minutes", async () => {
  const h = harness();
  await h.call(tagged("acme"));
  await h.call(tagged("acme")); // reload
  await h.call(tagged("acme", "pdf")); // a different event still alerts
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1].content.subject, /opened the PDF/);
  h.advance(30);
  await h.call(tagged("acme"));
  assert.equal(h.sent.length, 3);
  assert.equal(h.rows().length, 4, "every hit is still stored");
});

test("alerts are capped per hour across tags, then resume the next hour", async () => {
  const h = harness();
  for (let i = 0; i < ALERTS_PER_HOUR + 3; i++) await h.call(tagged(`co-${i}`));
  assert.equal(h.sent.length, ALERTS_PER_HOUR);
  assert.equal(h.rows().length, ALERTS_PER_HOUR + 3);
  h.advance(60);
  await h.call(tagged("later"));
  assert.equal(h.sent.length, ALERTS_PER_HOUR + 1);
});

test("alert failures and missing email settings never change the 204 or the row", async () => {
  const down = harness({ mailFail: true });
  assert.deepEqual(await down.call(tagged("acme")), { status: 204 });
  assert.equal(down.rows().length, 1);
  assert.equal(down.errors.length, 1);
  assert.ok(!down.errors[0].includes("203.0.113.7"));

  const off = harness({ config: { ...CONFIG, alert: null } });
  await off.call(tagged("acme"));
  assert.equal(off.rows().length, 1);
  assert.equal(off.sent.length, 0);
});

test("buildAlertEmail shows unknowns plainly", () => {
  const mail = buildAlertEmail(
    { tag: "x", event: "pdf", ts: new Date("2026-07-01T16:00:00Z"), country: "", networkOrg: "", asn: "", referrer: "", userAgent: "" },
    ALERT,
  );
  assert.match(mail.content.plainText, /Country: \(unknown\)\nNetwork: \(unknown\)/);
  assert.match(mail.content.plainText, /9:00 AM PDT/);
});
