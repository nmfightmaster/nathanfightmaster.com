# Resume

Source for [nathanfightmaster.com](https://nathanfightmaster.com), Nathan Fightmaster's resume. It is a single
static page, built with Astro and Tailwind CSS v4 and hosted on Azure Static Web Apps. The page
ships no client-side JavaScript. Its print stylesheet lays it out as a one-page, letter-size PDF,
which the build renders and publishes as `/Nathan-Fightmaster-Resume.pdf`.

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
public/        static files (favicon)
scripts/       build-pdf.mjs (both builds, PDF render, page and leak checks)
```
