import type { APIRoute } from "astro";
import { siteUrl } from "../data/seo";

// Allow everything. The PDF is kept out of search by an X-Robots-Tag header
// (public/staticwebapp.config.json), not here: a robots.txt block can't de-index a linked URL.
export const GET: APIRoute = () =>
  new Response(`User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}sitemap.xml\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
