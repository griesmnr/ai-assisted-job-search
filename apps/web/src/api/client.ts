/**
 * Thin fetch wrapper over apps/api's REST surface. Every function here maps
 * 1:1 to one route and returns the exact @app/shared response type that
 * route sends — this file never redeclares a shape, per CLAUDE.md's
 * "separate app forces a real REST contract boundary" decision (ticket
 * 484889d audited apps/api/src/routes/*.ts directly before writing this).
 *
 * Base URL: apps/api has no fixed port config beyond index.ts's
 * `PORT ?? 3000` default, so `VITE_API_BASE_URL` overrides it for anyone
 * running the API on a different port, defaulting to
 * `http://localhost:3000` for the common case.
 */
import { getUserId } from "../identity";
import type {
  CreateResumeRequest,
  CreateResumeResponse,
  EstimateProgressResponse,
  EstimateSearchRequest,
  EstimateSearchResponse,
  GetAllResultsResponse,
  GetResumeResponse,
  GetResumeResultsResponse,
  GetSourcesResponse,
  ListResumesResponse,
  MagicLinkRejectionReason,
  RequestMagicLinkRequest,
  RequestMagicLinkResponse,
  SearchCriteria,
  SearchStatusResponse,
  SetJobStatusResponse,
  StartSearchRequest,
  StartSearchResponse,
  UpdateResumeNicknameRequest,
  UpdateResumeNicknameResponse,
  UpdateResumeTextRequest,
  UpdateResumeTextResponse,
  UserJobStatus,
  VerifyMagicLinkRequest,
  VerifyMagicLinkResponse,
} from "@app/shared";

const API_BASE_URL: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:3000";

/**
 * Nicole's separate resume-tailoring app (ticket dbfd594) — a different
 * origin/deployment entirely, not part of this monorepo. Overridable the
 * same way `API_BASE_URL` is, since the real URL can differ between her
 * local dev instance and the deployed one.
 */
export const RESUME_OPTIMIZER_APP_URL: string =
  (import.meta.env.VITE_RESUME_OPTIMIZER_APP_URL as string | undefined) ??
  "https://ai-job-search-assistant-beta.vercel.app/";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /**
     * The parsed JSON error body, when the response had one (ticket
     * 3f05144). Some of this API's error responses carry more than a
     * message: `POST /searches` answers a second, overlapping run for the
     * same resume with `409 { error, searchId }`, and that `searchId` is
     * the id of the run that is ALREADY spending money — the one thing a
     * caller most needs after losing its own copy of it. Dropping the body
     * on the floor (the previous behavior) turned a recoverable
     * "reconnect to the run you already started" into a dead-end error
     * message. `unknown`, not a typed shape: this is whatever that route
     * sent, and every reader must narrow it itself.
     */
    public readonly body?: unknown,
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
      // Ticket dba885e: every request carries the anonymous per-browser
      // identity (identity.ts) — the API now rejects any request missing
      // this header. `...init?.headers` still wins if a future caller
      // ever needs to override it (none do today).
      headers: {
        "Content-Type": "application/json",
        "x-user-id": getUserId(),
        ...init?.headers,
      },
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
    let body: unknown;
    try {
      body = await response.json();
      const errorText = (body as { error?: unknown } | null)?.error;
      if (typeof errorText === "string" && errorText.length > 0) message = errorText;
    } catch {
      // Body wasn't JSON (or was empty) — the status-line message stands.
    }
    throw new ApiError(response.status, message, body);
  }

  // 202/204 responses may have no body; guard rather than let .json() throw.
  const text = await response.text();
  return (text.length > 0 ? JSON.parse(text) : undefined) as T;
}

export function getSources(): Promise<GetSourcesResponse> {
  return request<GetSourcesResponse>("/sources");
}

/**
 * Creates a NEW resume from pasted text.
 *
 * Ticket 6ba221e: no longer takes `currentResumeId`. That argument existed
 * (ticket 7701534) so the server could tell "resubmitting my own unchanged
 * text" apart from "this text already belongs to a DIFFERENT saved resume"
 * and reject the latter with a 409; that rejection is gone, so there is
 * nothing to distinguish. Changing an EXISTING resume's text is
 * `updateResumeText` below, not this call -- which is the actual fix for
 * "I edited Resume 1 and it became Resume 2".
 */
export function createResume(resumeText: string): Promise<CreateResumeResponse> {
  const body: CreateResumeRequest = { resumeText };
  return request<CreateResumeResponse>("/resumes", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Ticket 303cff0 ("My Resumes" tab): every saved resume's id/nickname/
 * createdAt, cheap (no `resumeText`) — the tab fetches a resume's full
 * text on demand, one at a time, via `getResume` below.
 */
export function listResumes(): Promise<ListResumesResponse> {
  return request<ListResumesResponse>("/resumes");
}

/**
 * Ticket 303cff0: a single resume's full text, fetched on demand when the
 * "My Resumes" tab expands one row — never preloaded for the whole list.
 */
export function getResume(resumeId: string): Promise<GetResumeResponse> {
  return request<GetResumeResponse>(`/resumes/${encodeURIComponent(resumeId)}`);
}

/**
 * Renames a resume's nickname (ticket 38a7598) — the ONE field
 * `PATCH /resumes/:id` can change (see `UpdateResumeNicknameRequest`'s doc
 * comment in @app/shared for why text lives on its own route instead).
 * Used both for an explicit later rename and for confirming an edited
 * default right in `ResumeInput.tsx`'s own submission flow, before the
 * user ever leaves that form.
 */
export function updateResumeNickname(
  resumeId: string,
  resumeNickname: string,
): Promise<UpdateResumeNicknameResponse> {
  const body: UpdateResumeNicknameRequest = { resumeNickname };
  return request<UpdateResumeNicknameResponse>(`/resumes/${encodeURIComponent(resumeId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

/**
 * Replaces an EXISTING resume's text in place (ticket 6ba221e) — same id,
 * same nickname, same attached scores. Distinct from `createResume` above,
 * which always means "a new resume"; see `UpdateResumeTextRequest`
 * (@app/shared) for why this is its own route rather than a field on the
 * nickname PATCH, and for the per-edit Claude cost it carries.
 */
export function updateResumeText(
  resumeId: string,
  resumeText: string,
): Promise<UpdateResumeTextResponse> {
  const body: UpdateResumeTextRequest = { resumeText };
  return request<UpdateResumeTextResponse>(`/resumes/${encodeURIComponent(resumeId)}/text`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export type GetResultsParams = {
  source?: string;
  minScore?: number;
  status?: UserJobStatus;
  /** Ticket bec2f98: bypass the API's default dismissed-exclusion so a
   * dismissed job comes back too, with its real status, instead of leaving
   * the visible set entirely. */
  includeDismissed?: boolean;
};

export function getResults(
  resumeId: string,
  params: GetResultsParams = {},
): Promise<GetResumeResultsResponse> {
  const query = new URLSearchParams();
  if (params.source !== undefined) query.set("source", params.source);
  if (params.minScore !== undefined) query.set("minScore", String(params.minScore));
  if (params.status !== undefined) query.set("status", params.status);
  if (params.includeDismissed) query.set("includeDismissed", "true");
  const qs = query.toString();
  return request<GetResumeResultsResponse>(
    `/resumes/${encodeURIComponent(resumeId)}/results${qs ? `?${qs}` : ""}`,
  );
}

/**
 * Ticket 3f0883f: the cross-resume counterpart to `getResults` above --
 * `GET /results`, no `resumeId` at all. Same `GetResultsParams` shape
 * (there's nothing resume-specific about `source`/`minScore`/`status`/
 * `includeDismissed`), reused rather than a near-duplicate type.
 */
export function getAllResults(params: GetResultsParams = {}): Promise<GetAllResultsResponse> {
  const query = new URLSearchParams();
  if (params.source !== undefined) query.set("source", params.source);
  if (params.minScore !== undefined) query.set("minScore", String(params.minScore));
  if (params.status !== undefined) query.set("status", params.status);
  if (params.includeDismissed) query.set("includeDismissed", "true");
  const qs = query.toString();
  return request<GetAllResultsResponse>(`/results${qs ? `?${qs}` : ""}`);
}

/**
 * `estimateRequestId` (ticket bf2dd0a) is optional and, when supplied, is
 * purely a progress-tracking token — see `getEstimateProgress` below and
 * @app/shared's `EstimateSearchRequest.estimateRequestId` doc comment for
 * the full design. It changes nothing about what this call returns or when.
 */
export function estimateSearch(
  resumeId: string,
  sourceIds: string[],
  criteria?: SearchCriteria,
  estimateRequestId?: string,
): Promise<EstimateSearchResponse> {
  const body: EstimateSearchRequest = { resumeId, sourceIds, criteria, estimateRequestId };
  return request<EstimateSearchResponse>("/searches/estimate", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Ticket bf2dd0a: polls the in-memory progress record for an
 * `estimateRequestId` previously passed to `estimateSearch` — meant to be
 * called on a timer WHILE that call's promise is still pending, so a caller
 * can show "3 of 8 sources checked" instead of a bare spinner during
 * `POST /searches/estimate`'s (deliberately synchronous, see design c54b9e0
 * §9) blocking wait. A 404 here is the NORMAL, expected shape of "nothing to
 * report yet" (see `EstimateProgressResponse`'s own doc comment in
 * @app/shared) — callers should treat it as "no progress data available",
 * not surface it as an error; `SearchFlow.tsx`'s poll loop does exactly
 * that.
 */
export function getEstimateProgress(estimateRequestId: string): Promise<EstimateProgressResponse> {
  return request<EstimateProgressResponse>(
    `/searches/estimate/${encodeURIComponent(estimateRequestId)}/progress`,
  );
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

/** Ticket dbfd594-followup (dogfooding, 2026-09-08): "untoggle" a job back
 * to no-action-taken -- removes the status row entirely rather than
 * writing a new "none" enum value (see routes/job-status.ts's own doc
 * comment on why). */
export function clearJobStatus(jobId: string): Promise<void> {
  return request<void>(`/jobs/${encodeURIComponent(jobId)}/status`, { method: "DELETE" });
}

export type CreateHandoffResponse = {
  id: string;
  expiresAt: string;
};

/**
 * Ticket dbfd594: snapshots a job's description + this resume's text
 * server-side, returning a short-lived `id` — see apps/api/src/routes/
 * handoffs.ts's own doc comment for why this exists (a cross-origin app
 * can't be handed a payload via localStorage or a bare URL param, so this
 * app hands over a small, safe pointer instead).
 */
export function createHandoff(jobId: string, resumeId: string): Promise<CreateHandoffResponse> {
  return request<CreateHandoffResponse>("/handoffs", {
    method: "POST",
    body: JSON.stringify({ jobId, resumeId }),
  });
}

/**
 * The absolute URL the RECEIVING app (a different origin) fetches to read
 * a handoff's payload — never a relative path, since that app has no
 * notion of "relative to this app". Exported so `ResultCard.tsx` can build
 * it without hand-duplicating `API_BASE_URL` string concatenation.
 */
export function handoffFetchUrl(handoffId: string): string {
  return `${API_BASE_URL}/handoffs/${encodeURIComponent(handoffId)}`;
}

/**
 * Ticket 9f06f8f: asks the API to email a single-use sign-in link to
 * `email`. Resolves once the provider has ACCEPTED the message -- never a
 * guarantee it landed in an inbox, which no provider API can promise
 * synchronously, so the "check your inbox" copy this feeds must not claim
 * delivery.
 *
 * A `503` means the email provider could not be reached or is not
 * configured -- it is not the user's mistake, so a caller must not treat it
 * like the 400 for a malformed address. Ticket 43423eb (CAUSE CONFIRMED on
 * that ticket): the real-world trigger was Resend's 403 for an unverified
 * sender domain, which stays broken until someone changes configuration --
 * permanent, not transient -- so a caller must NOT, symmetrically, invite a
 * retry either. (An earlier version of this comment said the opposite; that
 * is the exact claim the ticket's copy fix was about, just smuggled in here
 * where nobody reads server copy for it.) The 503's own message already
 * says only what is true -- that the failure was logged -- and callers
 * should render it as-is rather than deciding independently whether trying
 * again is worth suggesting.
 */
export function requestMagicLink(email: string): Promise<RequestMagicLinkResponse> {
  const body: RequestMagicLinkRequest = { email };
  return request<RequestMagicLinkResponse>("/auth/magic-link", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Ticket 9f06f8f: redeems the token from an emailed link, returning the
 * identity this browser must use from here on.
 *
 * POST, with the token in the BODY rather than in the URL -- see
 * apps/api/src/routes/auth.ts's header comment for the full reasoning (a GET
 * would put the credential in server logs and in the `Referer` of every
 * later request from the page, and would be consumed by the link scanners
 * that follow URLs in mail).
 *
 * A rejection is an `ApiError` whose `body` carries a
 * `MagicLinkRejectionReason` -- read it via `magicLinkRejectionReason`
 * below rather than by string-matching the message.
 */
export function verifyMagicLink(token: string): Promise<VerifyMagicLinkResponse> {
  const body: VerifyMagicLinkRequest = { token };
  return request<VerifyMagicLinkResponse>("/auth/magic-link/verify", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Pulls the machine-readable refusal code out of a failed `verifyMagicLink`.
 *
 * Structural, not `instanceof ApiError`, for the same reason
 * `isNicknameConflictError` (App.tsx) and `apiErrorStatus` (SearchFlow.tsx)
 * are: component tests mock `./api/client` wholesale, so the `ApiError` class
 * identity a mocked rejection carries is not guaranteed to be the one this
 * module defines.
 */
export function magicLinkRejectionReason(err: unknown): MagicLinkRejectionReason | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const body = (err as { body?: unknown }).body;
  if (typeof body !== "object" || body === null) return undefined;
  const reason = (body as { reason?: unknown }).reason;
  const known: MagicLinkRejectionReason[] = [
    "invalid",
    "expired",
    "already_used",
    "browser_already_claimed",
    "different_browser",
  ];
  return known.find((candidate) => candidate === reason);
}

/**
 * True only when a `verifyMagicLink` rejection means the POST never got a
 * response at all -- no server process ever ran, so nothing could have
 * claimed the token (ticket c719af2, review round 2).
 *
 * Keys on `status === 0`, which `request()` above assigns in EXACTLY ONE
 * place: the `catch` around `fetch` itself, when `fetch` rejects (network
 * down, DNS failure, CORS refusal) before any `Response` exists. No real
 * HTTP response ever carries status `0`, and every other throw this module
 * produces -- a non-2xx `ApiError` (real status, e.g. 400/500), or a thrown
 * `SyntaxError`/`TypeError` from a 200 whose body didn't parse -- carries
 * something other than `0` (frequently nothing at all, since those are not
 * `ApiError`s). So `neverLanded` is also deliberately NOT satisfied by "the
 * body came back unreadable": a 200 proves the server-side verify
 * transaction already committed (see routes/auth.ts), so a token behind an
 * unparseable 200 is just as spent as one behind a readable one -- treating
 * that as "never landed" would resurrect this exact ticket's bug one layer
 * down. Structural, not `instanceof ApiError`, for the same reason
 * `magicLinkRejectionReason` above is: component tests mock this module
 * wholesale.
 */
export function neverLanded(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  return (err as { status?: unknown }).status === 0;
}
