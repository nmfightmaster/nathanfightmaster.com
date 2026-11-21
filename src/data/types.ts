/** Shapes for the resume data. Components render these; they never hardcode resume text. */

/** Display dates, e.g. "Feb 2026". `end` is "Present" for current work. */
export interface DateRange {
  start: string;
  end: string;
}

export interface Bullet {
  text: string;
  /** First bullet removed if the PDF doesn't fit on one page. */
  cutFirst?: boolean;
}

export interface Header {
  name: string;
  title: string;
  location: string;
  email: string;
  /** PDF only; never rendered on the web page. Supplied at build time, not committed. */
  phone?: string;
  /** PDF only, so a printed or forwarded copy links back to the live site. */
  site: string;
}

export interface Role {
  title: string;
  dates: DateRange;
}

export interface Project {
  name: string;
  dates: DateRange;
  /** One-line description: what it is, who uses it, team, stack. */
  context: string;
  bullets: Bullet[];
}

export interface Employer {
  name: string;
  location: string;
  /** Full tenure across all titles. */
  dates: DateRange;
  /** Official titles, newest first. */
  roles: Role[];
  /** Note bridging the IT titles and the engineering work. */
  transition: string;
  projects: Project[];
  /** Condensed pre-engineering IT work, shown at the end of the employer block. */
  earlier: string;
}

export interface SkillGroup {
  label: string;
  items: string[];
}

export interface Resume {
  header: Header;
  summary: string;
  experience: Employer[];
  skills: SkillGroup[];
}
