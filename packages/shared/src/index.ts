/**
 * Placeholder export for @app/shared.
 *
 * Proves the package builds, is importable from both apps/api and apps/web
 * via the pnpm workspace protocol, and is covered by the root Vitest run.
 * Real shared types/utilities (e.g. the Job/Match domain types) land here
 * as the API and web contract solidifies.
 */
export function ping(): string {
  return "pong";
}

export type Job = {
  id: string;
  externalId: string;
  dataSource: "usajobs" | "wa-state" | "greenhouse" | "lever" | "ashby" | "smartrecruiters";
  title: string;
  description: string;
  company: string;
  // Optional because not every source knows. USAJOBS publishes structured
  // pay and schedule codes; Greenhouse's board API carries neither, for any
  // posting. Requiring them would mean either dropping those sources or
  // guessing — and a guess here writes invented data into the database.
  // "Not stated" is the honest representation of a posting that doesn't state it.
  payType?: "hourly" | "salary";
  commitment?: "full-time" | "part-time" | "contract";
  // Also optional, same reasoning. Measured against real Greenhouse boards:
  // Airbnb asks a custom "Workplace Type" question so this maps cleanly;
  // Discord asks nothing equivalent. Requiring it meant 0 of 3 Discord jobs
  // surviving normalization. A posting that doesn't state its work
  // arrangement genuinely doesn't state it.
  locationType?: "remote" | "onsite" | "hybrid";
  location?: string;
  linkToApply: string;
  postedAt: Date;
};

export type Resume = {
  id: string;
  resumeText: string;
};

export type JobMatch = {
  id: string;
  resumeId: string;
  jobId: string;
  matchScore: number;
  rationale: string;
};

export type Search = {
  id: string;
  resumeId: string;
  searchedAt: Date;
};

export type SearchResult = {
  id: string;
  searchId: string;
  jobId: string;
};

export type SearchSource = {
  searchId: string;
  sourceDescriptorId: string;
};

export type SourceDescriptor = {
  id: string;
  displayName: string;
};
