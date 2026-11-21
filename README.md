# Resume

Source for [nathanfightmaster.com](https://nathanfightmaster.com), Nathan Fightmaster's resume. It is a single
static page, built with Astro and Tailwind CSS v4 and hosted on Azure Static Web Apps. The only
client-side JavaScript is a small analytics beacon. Its print stylesheet lays it out as a
one-page, letter-size PDF, which the build renders and publishes as
`/Nathan-Fightmaster-Resume.pdf`.

## How this site works

```
build:    src/data/resume.ts ─► Astro ─► static HTML ─┬─► Azure Static Web Apps
                                 └► Playwright ─► PDF ┘

visits:   page beacon ─► /api/visit (Azure Function) ─► Table Storage
                                    └─► alert email (tagged links only)

weekly:   GitHub Actions ─► digest email + delete rows older than 90 days
```

- **One data file.** Every word of the resume lives in `src/data/resume.ts`. The page, the PDF,
  and the search/link-preview metadata are all generated from it, so they can't drift apart.
- **The PDF is the web page, printed.** There's no separate PDF template. The build prints the
  page with its print stylesheet in headless Chromium and enforces one page: it drops bullets
  marked as optional if it has to, and fails the build if that isn't enough. The phone number
  goes only into the PDF; the build checks that it never reaches the HTML.
- **Hosting.** GitHub Actions builds the site and deploys it to Azure Static Web Apps on every
  push to `main`; each pull request gets its own preview environment.
- **Analytics, built rather than bought.** A few lines of script send a fire-and-forget
  `sendBeacon` on page view and PDF click; the page behaves the same if it fails. An Azure
  Function (`api/`) drops bots, looks up the visitor's country and network owner in a local
  IPinfo Lite database (no third-party lookup API), stores the IP only as a salted HMAC, and
  writes one row to Azure Table Storage. Links shared with a `?r=<tag>` tracking tag also send an
  instant email through Azure Communication Services, deduplicated and capped per hour.
- **Digest and retention.** A scheduled GitHub Actions job (`digest/`) emails a weekly summary,
  grouped by tracking tag and network, and deletes rows older than 90 days. It signs in to Azure
  with OIDC (Entra ID), so the workflow holds no storage or email keys.
- **This repo is a published copy.** The site is developed in a private repo. On each merge to
  `main`, a workflow (`.github/workflows/sync-public-repo.yml`) copies an allowlist of paths here
  as one commit, after a guard checks that nothing outside the allowlist or containing the phone
  number slipped in.

## Develop

Requires Node 22.12+.

```sh
npm install
npx playwright install chromium   # once, for the PDF step
npm run dev         # local dev server
npm run build       # type-check, build the site to dist/, then render the PDF into dist/
npm run build:web   # type-check and build the site only (no PDF, faster)
npm run preview     # serve the built dist/
```

## PDF

[`scripts/build-pdf.mjs`](scripts/build-pdf.mjs) runs both Astro builds and renders the PDF:

1. The web build goes to `dist/` with `RESUME_PHONE` forced empty, so the phone number never
   reaches the HTML (even if it's set in your shell or an `.env` file).
2. A second build with the phone goes to `.pdf-build/` (temporary, git-ignored). Playwright's
   Chromium prints it with the print stylesheet to `dist/Nathan-Fightmaster-Resume.pdf`.
3. If the PDF runs over one page, it is printed again with the `cutFirst` bullets (marked in
   `resume.ts`) hidden, and the build logs a warning naming them. If it is still over one page,
   the build fails. The web page always shows every bullet.
4. Leak check: the build fails if the phone's digits, in any formatting, appear in any file in
   `dist/` other than the PDF.

## Editing content

All resume text lives in [`src/data/resume.ts`](src/data/resume.ts), and that file is the only
place to edit it. Its types are in [`src/data/types.ts`](src/data/types.ts). The components in
`src/components/` render that data and contain no resume text. Page metadata (title,
description, Open Graph, JSON-LD) is built from the same data in
[`src/data/seo.ts`](src/data/seo.ts).

The print layout has one to two lines to spare. Adding a bullet or skill will probably push the
PDF onto a second page, and the build will then cut the `cutFirst` bullets or fail. Check the PDF
after any content change.

## Phone number

The phone number appears only in the PDF and is never committed. The build reads it from the
`RESUME_PHONE` environment variable, or from `.env.local` (git-ignored):

```sh
RESUME_PHONE="555-555-5555" npm run build
```

Locally, if it's unset, the build warns and makes a PDF without a phone number. In CI it is
required, and the build fails without it. It comes from the `RESUME_PHONE` repository secret.

Use `npm run build`, not `npx astro build` directly. A bare Astro build reads `.env.local`
and would put the number in the HTML source.

## Deploy

[`.github/workflows/azure-static-web-apps-proud-mushroom-046f10a1e.yml`](.github/workflows/azure-static-web-apps-proud-mushroom-046f10a1e.yml)
runs `npm ci`, installs Chromium, and runs `npm run build` (with the `RESUME_PHONE` secret) in
GitHub Actions. It then uploads the prebuilt `dist/` to Azure Static Web Apps (`skip_app_build`)
on every push to `main`. Pull requests against `main` get preview environments.

## Layout

```
src/
  data/        resume.ts (content), types.ts, seo.ts
  components/  page sections (Header, Summary, Experience, Skills, ...)
  layouts/     Base.astro (document head and meta tags)
  pages/       index.astro
  styles/      global.css (Tailwind, fonts, print stylesheet)
public/        static files (favicon, staticwebapp.config.json)
scripts/       build-pdf.mjs (both builds, PDF render, page and leak checks)
api/           Azure Function: POST /api/visit (beacon ingest, tracked-link alerts)
digest/        weekly digest email and 90-day retention job
```
