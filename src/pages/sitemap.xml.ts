import type { APIRoute } from "astro";
import { siteUrl } from "../data/seo";

// One page. No <lastmod>: a hand-maintained date goes stale, and a build-time date would claim
// a change on every deploy.
export const GET: APIRoute = () =>
  new Response(
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${siteUrl}</loc></url>
</urlset>
`,
    { headers: { "Content-Type": "application/xml; charset=utf-8" } },
  );
