import { useEffect, useState } from "react";
import type { UserJobStatus } from "@app/shared";
import { createResume, setJobStatus } from "./api/client";
import { ResultsList } from "./components/ResultsList";
import { ResumeInput } from "./components/ResumeInput";
import { SearchFlow } from "./components/SearchFlow";
import { SourceToggles } from "./components/SourceToggles";
import { useResults } from "./hooks/useResults";
import { useSources } from "./hooks/useSources";

/**
 * The whole v1 product screen (ticket 484889d — see its git-bug for the
 * full decision history this implements):
 *
 *   1. Paste a resume -> POST /resumes.
 *   2. Toggle sources -> filters the (already fetched) scored corpus
 *      instantly, client-side. Never triggers a fetch (decision #3).
 *   3. Explicit "Estimate search cost" / "Run search" flow (SearchFlow) ->
 *      the only place this app spends money, and only on confirm
 *      (decision #4).
 *   4. Curated results list, floor-applied with a stated hidden count, per
 *      job status controls (decision #1/#2).
 *
 * Single-user, no accounts, no login (decision #2 on the 2026-08-29
 * comment) -- there is exactly one implicit "user" and no session/auth
 * concept anywhere in this file or the API it talks to.
 */
function App() {
  const sourcesState = useSources();
  const [resumeId, setResumeId] = useState<string | undefined>(undefined);
  const [resumeSubmitting, setResumeSubmitting] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [selectedSourceIds, setSelectedSourceIds] = useState<Set<string>>(new Set());

  const { state: resultsState, refresh } = useResults(resumeId);

  // Default every CONFIGURED source to selected the first time the source
  // list loads, so the first thing a user sees isn't an empty toggle set
  // they have to fill in themselves. An unconfigured source is never
  // auto-selected -- it doesn't even appear in the toggle list (ticket
  // d480357: SourceToggles drops unconfigured entries before rendering).
  useEffect(() => {
    if (sourcesState.status !== "ready") return;
    setSelectedSourceIds((prev) => {
      if (prev.size > 0) return prev;
      return new Set(sourcesState.sources.filter((s) => s.configured).map((s) => s.id));
    });
  }, [sourcesState]);

  function toggleSource(sourceId: string) {
    setSelectedSourceIds((prev) => {
      const next = new Set(prev);
      if (next.has(sourceId)) next.delete(sourceId);
      else next.add(sourceId);
      return next;
    });
  }

  async function handleResumeSubmit(resumeText: string) {
    setResumeSubmitting(true);
    setResumeError(null);
    try {
      const { id } = await createResume(resumeText);
      setResumeId(id);
    } catch (err) {
      setResumeError(err instanceof Error ? err.message : String(err));
    } finally {
      setResumeSubmitting(false);
    }
  }

  async function handleSetStatus(jobId: string, status: UserJobStatus) {
    await setJobStatus(jobId, status, resumeId);
    refresh();
  }

  return (
    <main className="app">
      <h1>Job Search</h1>

      <section className="resume-section">
        <ResumeInput
          onSubmit={(text) => void handleResumeSubmit(text)}
          submitting={resumeSubmitting}
        />
        {resumeError && <p role="alert">Could not save resume: {resumeError}</p>}
        {resumeId && <p className="resume-confirmed">Resume ready.</p>}
      </section>

      {resumeId && (
        <>
          <section className="sources-section">
            <h2>Sources</h2>
            {sourcesState.status === "loading" && <p>Loading sources...</p>}
            {sourcesState.status === "error" && (
              <p role="alert">Could not load sources: {sourcesState.message}</p>
            )}
            {sourcesState.status === "ready" && (
              <SourceToggles
                // SourceToggles itself filters out `configured: false`
                // sources (ticket d480357) -- that invariant lives in the
                // component, not here, so it holds regardless of what a
                // caller passes. `checkSourceHealth` (GET /sources) is
                // unchanged and still reports every seeded source,
                // including unconfigured ones, for a possible future
                // admin/debug view.
                sources={sourcesState.sources}
                selected={selectedSourceIds}
                onToggle={toggleSource}
              />
            )}
          </section>

          <section className="search-section">
            <h2>Find new matches</h2>
            <SearchFlow
              resumeId={resumeId}
              sourceIds={[...selectedSourceIds]}
              onSearchComplete={refresh}
            />
          </section>

          <section className="results-section">
            <h2>Results</h2>
            {resultsState.status === "loading" && <p>Loading results...</p>}
            {resultsState.status === "error" && (
              <p role="alert">Could not load results: {resultsState.message}</p>
            )}
            {resultsState.status === "ready" && (
              <ResultsList
                data={resultsState.data}
                selectedSourceIds={selectedSourceIds}
                onSetStatus={handleSetStatus}
              />
            )}
          </section>
        </>
      )}
    </main>
  );
}

export default App;
