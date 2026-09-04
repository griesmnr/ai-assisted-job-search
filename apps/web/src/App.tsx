import { useEffect, useMemo, useState } from "react";
import type { SearchCriteria, UserJobStatus } from "@app/shared";
import { createResume, setJobStatus } from "./api/client";
import { ResultsList } from "./components/ResultsList";
import { ResumeInput } from "./components/ResumeInput";
import { SearchCriteriaForm } from "./components/SearchCriteriaForm";
import { SearchFlow } from "./components/SearchFlow";
import { SourceToggles } from "./components/SourceToggles";
import { useResults } from "./hooks/useResults";
import { useSources } from "./hooks/useSources";

/**
 * Splits a comma-separated text field into trimmed, non-empty phrases —
 * the one place this happens, shared by every SearchCriteria text field.
 */
function splitPhrases(text: string): string[] {
  return text
    .split(",")
    .map((phrase) => phrase.trim())
    .filter((phrase) => phrase.length > 0);
}

/**
 * Derives the actual `SearchCriteria` to send from the current title chips
 * and the remaining plain-text fields (ticket 39b4a48, superseding ticket
 * 957bc22's undefined-vs-{} design).
 *
 * ALWAYS returns a real `SearchCriteria` object now, never `undefined` --
 * this is the deliberate fix for a real gap ticket 957bc22 left open.
 * `compileFilter` (apps/api/src/sources/criteria.ts) treats `undefined` as
 * "reproduce the OLD hardcoded software-engineering default" (including
 * ticket 6b2313a's staff-level title exclusion) and a real object,
 * even `{}`, as "no title restriction beyond what's actually specified."
 * Nicole was explicit that the old default must never come back silently:
 * "I'd rather have it be a really expensive search offered than a blind
 * default." Zero title chips now means a real, visible "search every
 * title" state (an empty `titleInclude` is simply omitted from the
 * object, which is what "no restriction" already means to compileFilter)
 * -- never a silent fallback to the hidden default a user never chose.
 */
function buildSearchCriteria(form: {
  titleChips: string[];
  nearLocations: string;
  remoteOk: boolean;
  commitmentIn: ("full-time" | "part-time" | "contract")[];
}): SearchCriteria {
  const nearLocations = splitPhrases(form.nearLocations);
  const criteria: SearchCriteria = {};
  if (form.titleChips.length > 0) criteria.titleInclude = form.titleChips;
  if (nearLocations.length > 0) criteria.nearLocations = nearLocations;
  if (form.remoteOk) criteria.remoteOk = true;
  if (form.commitmentIn.length > 0) criteria.commitmentIn = form.commitmentIn;
  return criteria;
}

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
type Tab = "search" | "scored";

function App() {
  const sourcesState = useSources();
  // Ticket f4a7f07: "New Job Search" and "Already Scored Jobs". Nicole,
  // after several rounds of thinking out loud, settled on exactly these
  // two -- no saved/other sub-split yet ("I haven't figured that out
  // yet"), and moving results out of the main flow entirely is itself the
  // fix for a separate thing she flagged: previously-scored results
  // appearing inline the moment a resume is pasted, before any new search
  // runs, read as "jarring... old stuff".
  const [activeTab, setActiveTab] = useState<Tab>("search");
  const [resumeId, setResumeId] = useState<string | undefined>(undefined);
  const [resumeSubmitting, setResumeSubmitting] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [selectedSourceIds, setSelectedSourceIds] = useState<Set<string>>(new Set());
  // Ticket 39b4a48: starts empty, populated from POST /resumes's real
  // suggestedTitles the moment a resume is submitted (handleResumeSubmit
  // below) -- never a hardcoded default.
  const [titleChips, setTitleChips] = useState<string[]>([]);
  const [criteriaForm, setCriteriaForm] = useState<{
    nearLocations: string;
    remoteOk: boolean;
    commitmentIn: ("full-time" | "part-time" | "contract")[];
  }>({
    nearLocations: "",
    remoteOk: false,
    commitmentIn: [],
  });
  const criteria = useMemo(
    () => buildSearchCriteria({ titleChips, ...criteriaForm }),
    [titleChips, criteriaForm],
  );

  const { state: resultsState, refresh } = useResults(resumeId);

  // Ticket f4a7f07, refined live: "results should be reserved for results
  // from the most recent search... cleared every time a new search is
  // estimated or a filter is toggled, and they should only reappear when
  // the new search has come." This tracks whether the CURRENT tab's
  // results section should show anything at all -- it doesn't duplicate
  // the fetch (still reuses `resultsState.data` above, the same one
  // "Already Scored Jobs" reads), it just gates whether "New Job Search"
  // is currently allowed to display it. Reset to false by two effects
  // below (criteria/source change, and SearchFlow's onEstimateStart);
  // set true only by onSearchComplete, once a real run actually finishes.
  const [hasFreshSearchResults, setHasFreshSearchResults] = useState(false);

  useEffect(() => {
    setHasFreshSearchResults(false);
  }, [selectedSourceIds, criteria]);

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
      const { id, suggestedTitles } = await createResume(resumeText);
      setResumeId(id);
      // Defensive, not just decorative: an older cached client build, a
      // test fixture written before this field existed, or any future API
      // response shape drift should degrade to "no suggestions" rather
      // than crash buildSearchCriteria's `.length` check below.
      setTitleChips(suggestedTitles ?? []);
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

  function handleSearchComplete() {
    refresh();
    // The one place `hasFreshSearchResults` is ever set true — SearchFlow
    // only calls onSearchComplete when a run's poll result.status is
    // literally "complete" (never on "failed"/"incomplete"), so this is a
    // genuine successful run, not a speculative or partial one.
    setHasFreshSearchResults(true);
  }

  return (
    <main className="app">
      <h1>AI-Assisted Job Search</h1>

      <nav className="tab-nav" aria-label="Sections">
        <button
          type="button"
          className="tab-button"
          aria-pressed={activeTab === "search"}
          onClick={() => setActiveTab("search")}
        >
          New Job Search
        </button>
        <button
          type="button"
          className="tab-button"
          aria-pressed={activeTab === "scored"}
          onClick={() => setActiveTab("scored")}
        >
          Already Scored Jobs
        </button>
      </nav>

      {/* Ticket f4a7f07: both tabs stay MOUNTED at all times -- only
          `hidden` (the DOM attribute, not conditional rendering) toggles
          which one shows. This is deliberate and tied to ticket 3f05144
          (in-progress state silently lost on tab-discard/background): if
          switching tabs unmounted SearchFlow, an in-progress cost estimate
          or a running search's poll would be destroyed by the mere act of
          checking the other tab, which is exactly the kind of state loss
          Nicole flagged as a real problem. `hidden` keeps every hook
          (useSources, useResults) and every child component's internal
          state alive underneath, regardless of which tab is visible. */}
      <div hidden={activeTab !== "search"}>
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
              <h2>Which sources do you want to search?</h2>
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

            <section className="criteria-section">
              <h2>Narrow your search</h2>
              <SearchCriteriaForm
                titleChips={titleChips}
                nearLocations={criteriaForm.nearLocations}
                remoteOk={criteriaForm.remoteOk}
                commitmentIn={criteriaForm.commitmentIn}
                onTitleChipsChange={setTitleChips}
                onChange={setCriteriaForm}
              />
            </section>

            <section className="search-section">
              <h2>Find new matches</h2>
              <p className="search-pitch">
                This isn't a keyword search. Claude actually reads your resume against each job
                description, one at a time, and judges how well you'd really fit — that real reading
                is what the cost below pays for.
              </p>
              <SearchFlow
                resumeId={resumeId}
                sourceIds={[...selectedSourceIds]}
                criteria={criteria}
                onEstimateStart={() => setHasFreshSearchResults(false)}
                onSearchComplete={handleSearchComplete}
              />
            </section>

            {/* Ticket f4a7f07, refined live: this section shows ONLY the
                most recent search's results, and ONLY once one has
                actually completed since the last estimate/filter change --
                never previously-scored jobs left over from before. That's
                the deliberate distinction from "Already Scored Jobs"
                below: "there should be a distinction between these are
                the results of this current search, and they're not going
                to randomly populate with old stuff." Reuses the same
                `resultsState.data` fetch as the other tab (no duplicate
                request) -- `hasFreshSearchResults` just gates whether
                THIS section is allowed to show it right now.
                Known gap, follow-up ticket: this still uses the DEFAULT
                results view, which excludes dismissed jobs -- Nicole
                separately asked for a dismissed job to still appear here,
                visibly marked "Dismissed", which needs a small new API
                option this ticket doesn't add yet. */}
            {hasFreshSearchResults && resultsState.status === "ready" && (
              <section className="results-section">
                <h2>Results from this search</h2>
                {resultsState.data.results.length > 0 ||
                (resultsState.data.hiddenBelowFloor ?? 0) > 0 ? (
                  <ResultsList
                    data={resultsState.data}
                    selectedSourceIds={selectedSourceIds}
                    onSetStatus={handleSetStatus}
                  />
                ) : (
                  <p>No jobs matched this search.</p>
                )}
              </section>
            )}
          </>
        )}
      </div>

      <div hidden={activeTab !== "scored"}>
        <section className="results-section">
          <h2>Results</h2>
          {!resumeId && <p>Paste a resume in "New Job Search" to see your results here.</p>}
          {resumeId && resultsState.status === "loading" && <p>Loading results...</p>}
          {resumeId && resultsState.status === "error" && (
            <p role="alert">Could not load results: {resultsState.message}</p>
          )}
          {resumeId &&
            resultsState.status === "ready" &&
            (resultsState.data.results.length > 0 ||
            (resultsState.data.hiddenBelowFloor ?? 0) > 0 ? (
              <ResultsList
                data={resultsState.data}
                selectedSourceIds={selectedSourceIds}
                onSetStatus={handleSetStatus}
              />
            ) : (
              // Ticket f4a7f07: unlike ticket 093d9fe's inline-surprise
              // reasoning (hide entirely so an unrequested empty section
              // doesn't read as broken), this tab is somewhere Nicole
              // deliberately navigates TO -- a silently blank panel here
              // would itself read as broken, so an explicit "nothing yet"
              // message is the right call in this location specifically.
              <p>No jobs scored yet.</p>
            ))}
        </section>
      </div>
    </main>
  );
}

export default App;
