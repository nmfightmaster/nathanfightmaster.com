/**
 * Page metadata derived from resume.ts. Never reads `header.phone`: the phone number stays out
 * of meta tags and JSON-LD.
 */
import { resume } from "./resume";

const { header, summary, experience, skills } = resume;
const current = experience[0];

export const siteUrl = `https://${header.site}/`;

export const seo = {
  title: `${header.name} — ${header.title}`,
  description: summary,
  url: siteUrl,
  siteName: header.name,
};

/** schema.org Person. Fields chosen explicitly; no phone. */
export const personJsonLd = {
  "@context": "https://schema.org",
  "@type": "Person",
  name: header.name,
  jobTitle: header.title,
  url: siteUrl,
  email: `mailto:${header.email}`,
  address: {
    "@type": "PostalAddress",
    addressLocality: header.location.split(",")[0].trim(),
    addressRegion: header.location.split(",")[1]?.trim(),
  },
  worksFor: { "@type": "Organization", name: current.name },
  knowsAbout: skills.flatMap((g) => g.items),
  description: summary,
};
