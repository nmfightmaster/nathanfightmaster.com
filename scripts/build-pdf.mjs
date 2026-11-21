// Builds the site and its PDF from the same data.
//
//   1. Web build -> dist/, with RESUME_PHONE forced empty so the phone never reaches the HTML.
//   2. PDF build -> .pdf-build/, with RESUME_PHONE set.
//   3. Serve .pdf-build/, print it with Playwright (Chromium) to dist/<PDF_NAME>.
//   4. Over one page? Re-print with [data-cut-first] bullets hidden; still over -> fail.
//   5. Leak check: fail if the phone's digits appear in any dist/ file other than the PDF.
//
// Flags: --web-only  run step 1 only (fast local iteration; never leaks the phone).
//
// RESUME_PHONE comes from the environment, else from .env.production.local / .env.local /
// .env.production / .env (Vite's precedence). Unset: local builds warn and make a phone-less
// PDF; CI (CI=true) fails.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import { parseEnv } from "node:util";
import { PDFDocument } from "pdf-lib";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const PDF_BUILD = join(ROOT, ".pdf-build");
const PDF_NAME = "Nathan-Fightmaster-Resume.pdf"; // also in src/pages/index.astro and public/staticwebapp.config.json (noindex header)
const CUT_SELECTOR = "[data-cut-first]";

const webOnly = process.argv.includes("--web-only");
const isCI = !!process.env.CI && process.env.CI !== "false";

const log = (msg) => console.log(`[build-pdf] ${msg}`);
const warn = (msg) => console.warn(`[build-pdf] WARNING: ${msg}`);
class BuildError extends Error {}

function resolvePhone() {
  if (process.env.RESUME_PHONE) return process.env.RESUME_PHONE.trim();
  for (const file of [".env.production.local", ".env.local", ".env.production", ".env"]) {
    const path = join(ROOT, file);
    if (!existsSync(path)) continue;
    const value = parseEnv(readFileSync(path, "utf8")).RESUME_PHONE;
    if (value) return value.trim();
  }
  return "";
}

function astroBuild(outDir, phone) {
  const args = ["astro", "build"];
  if (outDir) args.push("--outDir", outDir);
  // An empty RESUME_PHONE in the process env beats any .env file, so the web build stays clean.
  const result = spawnSync("npx", args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, RESUME_PHONE: phone },
  });
  if (result.status !== 0) throw new BuildError(`astro build ${outDir ?? ""} failed`);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".json": "application/json",
};

function serve(dir) {
  const server = createServer((req, res) => {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path.endsWith("/")) path += "index.html";
    const file = normalize(join(dir, path));
    if (!file.startsWith(dir + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

async function print(page, url, { cut }) {
  await page.goto(url, { waitUntil: "networkidle" });
  if (cut) await page.addStyleTag({ content: `${CUT_SELECTOR} { display: none !important; }` });
  await page.evaluate(() => document.fonts.ready);
  const bytes = await page.pdf({ format: "Letter", preferCSSPageSize: true, printBackground: true });
  const doc = await PDFDocument.load(bytes);
  return { doc, pages: doc.getPageCount() };
}

async function renderPdf(phone) {
  const { chromium } = await import("playwright");
  const server = await serve(PDF_BUILD);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const url = `http://127.0.0.1:${server.address().port}/`;

    let { doc, pages } = await print(page, url, { cut: false });
    log(`rendered ${pages} page(s)`);
    if (pages > 1) {
      const cutText = await page.$$eval(CUT_SELECTOR, (els) => els.map((e) => e.textContent.trim()));
      ({ doc, pages } = await print(page, url, { cut: true }));
      if (pages > 1) {
        throw new BuildError(`PDF is ${pages} pages even with ${CUT_SELECTOR} bullets cut`);
      }
      warn(`PDF ran over one page; cut ${cutText.length} bullet(s) to fit:`);
      for (const text of cutText) warn(`  - ${text.replace(/\s+/g, " ")}`);
    }

    if (phone) {
      const html = await page.content();
      if (!html.replace(/\D/g, "").includes(digitsOf(phone))) {
        throw new BuildError("RESUME_PHONE was set but the phone is missing from the printed page");
      }
    }

    const name = (await page.textContent("h1"))?.trim();
    if (!name) throw new BuildError("no <h1> name found on the page");
    doc.setTitle(`${name} — Resume`);
    doc.setAuthor(name);
    doc.setCreator("");
    doc.setProducer("");
    writeFileSync(join(DIST, PDF_NAME), await doc.save());
    log(`wrote dist/${PDF_NAME}`);
  } finally {
    await browser.close();
    server.close();
  }
}

const digitsOf = (s) => s.replace(/\D/g, "");

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

function leakCheck(phone) {
  const digits = digitsOf(phone);
  if (digits.length < 7) throw new BuildError("RESUME_PHONE has fewer than 7 digits");
  // The digits in order, allowing a few non-digit separators between them: 509-555-1234,
  // (509) 555 1234, 509.555.1234 and 5095551234 all match.
  const pattern = new RegExp(digits.split("").join("\\D{0,3}"));
  const pdf = join(DIST, PDF_NAME);
  const leaks = [];
  for (const file of walk(DIST)) {
    if (file === pdf) continue;
    if (pattern.test(readFileSync(file).toString("latin1"))) leaks.push(relative(ROOT, file));
  }
  if (leaks.length) throw new BuildError(`phone number found outside the PDF: ${leaks.join(", ")}`);
  log("leak check passed: phone appears only in the PDF");
}

async function main() {
  const phone = resolvePhone();

  log("web build -> dist/ (RESUME_PHONE forced empty)");
  astroBuild(undefined, "");
  if (webOnly) {
    log("--web-only: skipping the PDF");
    return;
  }

  if (!phone) {
    if (isCI) throw new BuildError("RESUME_PHONE is not set (required in CI)");
    warn("RESUME_PHONE is not set; the PDF will have no phone number");
  }

  try {
    log("PDF build -> .pdf-build/ (RESUME_PHONE set)");
    astroBuild(PDF_BUILD, phone);
    await renderPdf(phone);
  } finally {
    rmSync(PDF_BUILD, { recursive: true, force: true });
  }

  if (phone) leakCheck(phone);
}

main().catch((err) => {
  console.error(`[build-pdf] ${err instanceof BuildError ? "FAILED: " + err.message : err.stack}`);
  process.exitCode = 1;
});
