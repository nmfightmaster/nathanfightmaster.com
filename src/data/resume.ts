/**
 * Single source of truth for all resume content (web page and PDF).
 * Components render this data and never hardcode resume text.
 */
import type { Resume } from "./types";

export const resume: Resume = {
  header: {
    name: "Nathan Fightmaster",
    title: "Full Stack Software Engineer",
    location: "Spokane, WA",
    email: "nathan@fightmaster.net",
    // Set RESUME_PHONE in the build environment; never commit the number.
    phone: import.meta.env.RESUME_PHONE || undefined,
    site: "nathanfightmaster.com",
  },

  summary:
    "Full stack software engineer building production healthcare applications with React, TypeScript, Node.js, and Azure, including an AI clinical-summary tool, a ~600-user scheduling app, and an HR recognition platform.",

  experience: [
    {
      name: "CHAS Health",
      location: "Spokane, WA",
      dates: { start: "Oct 2021", end: "Present" },
      roles: [
        {
          title: "Full Stack Software Engineer",
          dates: { start: "Feb 2026", end: "Present" },
        },
        {
          title: "Senior Service Desk Technician",
          dates: { start: "Dec 2025", end: "Feb 2026" },
        },
        {
          title: "Service Desk Technician II",
          dates: { start: "Jan 2023", end: "Dec 2025" },
        },
        {
          title: "Service Desk Technician",
          dates: { start: "Jan 2022", end: "Jan 2023" },
        },
      ],
      transition:
        "Built and shipped software for the Custom Solutions team from Jul 2024; moved into the engineering role when a position opened.",
      projects: [
        {
          name: "AI chart prep tool",
          dates: { start: "Jan 2026", end: "Present" },
          context:
            "Chrome extension that summarizes patient chart documents with page-level citations for nurses and clinicians (pilot); team of 3. React, TypeScript, Node.js, Python, Azure SQL, Azure PostgreSQL, Azure AI Foundry.",
          bullets: [
            {
              text: "Proposed and built an Azure Document Intelligence OCR pipeline to replace a single-VM server that stalled at 3–5 concurrent docs; 13,489 production docs, p99 under 1 min, zero poll timeouts.",
            },
            {
              text: "Capped the tool's athenahealth traffic with a restart-safe daily budget shared across services (450k/day under a 500k quota), per-instance limits, and a scale-out lock on the nightly job.",
            },
            {
              text: "Isolated clinician requests from the nightly batch and added deadlines to every task, document, and external call after two production hangs, so one bad document fails alone.",
            },
            {
              text: "Rebuilding the nurse-facing extension with Claude Code under a gated spec, build, hands-on athenahealth check, and retro process; 1,377 unit and 69 E2E automated tests.",
            },
          ],
        },
        {
          name: "Employee of the Month",
          dates: { start: "Feb 2026", end: "Present" },
          context:
            "HR's monthly recognition module (nominations, voting, approval, AI candidate summaries) inside the internal Employee Directory. React, TypeScript, Node.js, SQL Server, Azure AI Foundry.",
          bullets: [
            {
              // "5 monthly campaigns" grows monthly; keep the count current.
              text: "Took an unreleased prototype to production as sole developer (Jun 2026); it has run 5 monthly campaigns, and batching, retries, and a daily backfill cut missing AI summaries from ~5% to 0.",
            },
            {
              text: "Closed a pre-launch impersonation hole (the API trusted a browser-sent employee ID) with Entra ID token checks on every route, a central permission policy, and per-record ownership checks.",
            },
            {
              text: "Wrote a 286-test regression suite and a repo/dev/prod database drift check that found 11 bugs, 2 of them live in production.",
            },
          ],
        },
        {
          name: "Scheduling tool",
          dates: { start: "Jul 2024", end: "Present" },
          context:
            "Internal scheduling app used by ~600 staff across all clinics in place of athenahealth's scheduling screens; team of 3 developers. React, TypeScript, Node.js, SQL Server, athenahealth and Microsoft Graph APIs.",
          bullets: [
            {
              text: "Shipped in-app double-booking for medical and dental: creates and books the extra athenahealth slot, records the approver, and removes reopened slots on cancel so no phantom openings remain.",
            },
            {
              text: "Built the first version of Behavioral Health scheduling (BH visit reasons, provider scopes, 60-minute visits from paired 30-minute slots), opening the tool to BH schedulers.",
            },
            {
              text: "Built paired provider-to-specialist booking that matches each provider slot to a same-clinic specialist slot starting within 20 minutes.",
              cutFirst: true,
            },
          ],
        },
      ],
      earlier:
        "Before moving to software, built a React/Node.js asset manager and a Bash laptop-imaging script (role-based software installs, AD and asset registration) used by the ~20-person service desk.",
    },
  ],

  skills: [
    { label: "Languages", items: ["TypeScript", "JavaScript", "SQL (T-SQL)", "Bash"] },
    { label: "Frontend", items: ["React", "Tailwind CSS", "Chrome extensions"] },
    {
      label: "Backend & APIs",
      items: ["Node.js", "Express", "REST/OpenAPI", "athenahealth API", "Microsoft Graph API"],
    },
    { label: "Data", items: ["SQL Server", "Azure SQL", "Azure PostgreSQL"] },
    { label: "Testing", items: ["Vitest", "Playwright"] },
    {
      label: "Cloud & DevOps",
      items: [
        "Azure App Service",
        "Static Web Apps",
        "Container Apps",
        "Monitor",
        "Entra ID",
        "managed identities",
        "GitHub Actions",
        "Azure DevOps",
        "CodeQL",
      ],
    },
    {
      label: "AI",
      items: ["Azure AI Foundry", "Azure Document Intelligence", "AI coding agents (Claude Code, Codex)"],
    },
  ],
};
