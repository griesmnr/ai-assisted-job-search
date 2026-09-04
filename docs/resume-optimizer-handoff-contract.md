# Resume optimizer handoff contract

This is the contract between this app (the job search app) and Nicole's
separate resume-tailoring app, for the "Optimize Resume" button. Written
2026-09-04 (ticket dbfd594) so it can be handed to anyone/anything
(including a future ChatGPT session) working on the OTHER app's side
without needing this repo's full context.

## What's already built, here, in this repo

- `POST /handoffs` — body `{ jobId, resumeId }`. Looks up the real job and
  resume, snapshots `{ resumeText, jobDescription, jobTitle, company }`
  into a new row with a 10-minute expiry, returns `{ id, expiresAt }`.
  Only callable from this app's own frontend (normal CORS lockdown).
- `GET /handoffs/:id` — returns the snapshotted
  `{ resumeText, jobDescription, jobTitle, company }` as JSON, or 404 if
  the id is unknown or its 10-minute TTL has passed. **CORS is open on
  this one route** (`Access-Control-Allow-Origin` reflects any origin) —
  it's a read-only GET with no side effects, and the real access control
  is the token itself (an unguessable UUID) plus the short expiry, not
  which site is asking. This is the route the OTHER app needs to fetch.
- The "Optimize Resume" button (`apps/web/src/components/ResultCard.tsx`)
  calls `POST /handoffs`, then opens:

  ```
  <RESUME_OPTIMIZER_APP_URL>?import=<url-encoded GET /handoffs/:id URL>
  ```

  in a new tab. `RESUME_OPTIMIZER_APP_URL` currently defaults to
  `https://ai-job-search-assistant-beta.vercel.app/` (overridable via the
  `VITE_RESUME_OPTIMIZER_APP_URL` env var on this app's frontend).

  Concretely, today, the link looks like:

  ```
  https://ai-job-search-assistant-beta.vercel.app/?import=http%3A%2F%2Flocalhost%3A3000%2Fhandoffs%2F3fa85f64-5717-4562-b3fc-2c963f66afa6
  ```

  (that inner URL — `http://localhost:3000/handoffs/<id>` — is this app's
  own dev-mode API address; see "Known limitation" below.)

## What the OTHER app (the resume optimizer) needs to do

This is the entire patch needed on that side. Nothing else about that
app's own data model or UI needs to change.

1. On page load, read the `import` query parameter from the URL
   (`new URLSearchParams(window.location.search).get("import")`). If it's
   absent, do nothing different — this is purely additive.
2. If present, it's already a complete, ready-to-fetch URL (already
   URL-decoded by `URLSearchParams`). Do a plain, unauthenticated GET:

   ```js
   const importUrl = new URLSearchParams(window.location.search).get("import");
   if (importUrl) {
     const res = await fetch(importUrl);
     if (res.ok) {
       const { resumeText, jobDescription, jobTitle, company } = await res.json();
       // populate whatever local state/form fields this app already uses
       // for "the resume" and "the job description" -- exactly as if the
       // user had pasted them in by hand.
     } else {
       // 404 means the link is expired or already used up — show
       // something like "This link has expired — paste the job
       // description in manually," not a silent failure or a crash.
     }
   }
   ```

3. That's it. No auth header, no API key, no POST back to this app needed.
   The response body is always exactly:

   ```json
   {
     "resumeText": "string",
     "jobDescription": "string",
     "jobTitle": "string",
     "company": "string"
   }
   ```

## Known limitation — not yet solved by either side

This app (the job search app) is **not deployed publicly yet** — it only
runs locally today (`docker compose` / `pnpm dev`). That means the
`GET /handoffs/:id` URL embedded in a real link is currently
`http://localhost:3000/...`, which the deployed resume-optimizer app
(on Vercel) cannot reach from a browser running on Nicole's machine
UNLESS both apps happen to be running on the same machine and the
resume-optimizer app is ALSO being run locally (e.g. `vercel dev`) at
that moment.

**To make this work end-to-end for real** (the deployed optimizer app
fetching from a deployed job-search API), the job search app needs its
own public deployment, and then `VITE_RESUME_OPTIMIZER_APP_URL`'s
counterpart on the job-search side — really, the job-search app's own
`VITE_API_BASE_URL` used to build the `POST /handoffs` link and the
`GET /handoffs/:id` URL it embeds — needs to point at that public
deployment instead of `localhost:3000`. Nothing about the CONTRACT above
changes; only which literal URL gets embedded in the link.

Until then: this is fully real and testable locally (both apps running
on the same machine), and the patch described above can be built and
tested against a local `POST /handoffs` call today, ahead of either app
being deployed.
