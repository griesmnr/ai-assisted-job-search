/**
 * Thin fetch wrapper over apps/api's REST surface. Every function here maps
 * 1:1 to one route and returns the exact @app/shared response type that
 * route sends — this file never redeclares a shape, per CLAUDE.md's
 * "separate app forces a real REST contract boundary" decision (ticket
 * 484889d audited apps/api/src/routes/*.ts directly before writing this).
 *
 * Base URL: apps/api has no fixed port config beyond index.ts's
 * `PORT ?? 3000` default, and this is a local single-user dev tool (no
 * accounts, CLAUDE.md's stack table) — so `VITE_API_BASE_URL` overrides it
 * for anyone running the API on a different port, defaulting to
 * `http://localhost:3000` for the common case.
 */
import type {
  CreateResumeResponse,
  EstimateSearchRequest,
  EstimateSearchResponse,
  GetResumeResultsResponse,
  GetSourcesResponse,
  SearchCriteria,
  SearchStatusResponse,
  SetJobStatusResponse,
  StartSearchRequest,
  StartSearchResponse,
  UserJobStatus,
} from "@app/shared";

const API_BASE_URL: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:3000";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch (err) {
    // A network-level failure (API not running, CORS misconfigured, etc.)
    // reads identically to "fetch threw" from the caller's perspective —
    // wrapped here so every caller can catch one error type instead of
    // distinguishing TypeError-from-fetch vs. ApiError.
    const reason = err instanceof Error ? err.message : String(err);
    throw new ApiError(0, `Could not reach the API at ${API_BASE_URL}: ${reason}`);
  }

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Body wasn't JSON (or was empty) — the status-line message stands.
    }
    throw new ApiError(response.status, message);
  }

  // 202/204 responses may have no body; guard rather than let .json() throw.
  const text = await response.text();
  return (text.length > 0 ? JSON.parse(text) : undefined) as T;
}

export function getSources(): Promise<GetSourcesResponse> {
  return request<GetSourcesResponse>("/sources");
}

export function createResume(resumeText: string): Promise<CreateResumeResponse> {
  return request<CreateResumeResponse>("/resumes", {
    method: "POST",
    body: JSON.stringify({ resumeText }),
  });
}

export type GetResultsParams = {
  source?: string;
  minScore?: number;
  status?: UserJobStatus;
};

export function getResults(
  resumeId: string,
  params: GetResultsParams = {},
): Promise<GetResumeResultsResponse> {
  const query = new URLSearchParams();
  if (params.source !== undefined) query.set("source", params.source);
  if (params.minScore !== undefined) query.set("minScore", String(params.minScore));
  if (params.status !== undefined) query.set("status", params.status);
  const qs = query.toString();
  return request<GetResumeResultsResponse>(
    `/resumes/${encodeURIComponent(resumeId)}/results${qs ? `?${qs}` : ""}`,
  );
}

export function estimateSearch(
  resumeId: string,
  sourceIds: string[],
  criteria?: SearchCriteria,
): Promise<EstimateSearchResponse> {
  const body: EstimateSearchRequest = { resumeId, sourceIds, criteria };
  return request<EstimateSearchResponse>("/searches/estimate", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function startSearch(
  resumeId: string,
  sourceIds: string[],
  criteria?: SearchCriteria,
): Promise<StartSearchResponse> {
  const body: StartSearchRequest = { resumeId, sourceIds, criteria };
  return request<StartSearchResponse>("/searches", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getSearchStatus(searchId: string): Promise<SearchStatusResponse> {
  return request<SearchStatusResponse>(`/searches/${encodeURIComponent(searchId)}`);
}

export function setJobStatus(
  jobId: string,
  status: UserJobStatus,
  resumeId?: string,
): Promise<SetJobStatusResponse> {
  return request<SetJobStatusResponse>(`/jobs/${encodeURIComponent(jobId)}/status`, {
    method: "POST",
    body: JSON.stringify({ status, resumeId }),
  });
}
