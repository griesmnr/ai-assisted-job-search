// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GetSourcesResponse, ListResumesResponse } from "@app/shared";
import App from "./App";

/**
 * Ticket 3db5b35 (reverses 5a79aa4/cdc2c39 -- see ResumeInput.tsx's
 * top-of-file doc comment and App.tsx's `handleResumeSubmit` comment for
 * the full argument). Jay's feedback, relayed by Nicole: "I want users to
 * be able to see the field where the nickname is pasted, put in whatever
 * your suggestion is, but then let them edit it even before saving it."
 *
 * These tests cover the NEW behavior end to end, through `App`, not just
 * `ResumeInput` in isolation: a pre-save suggestion derived from the
 * already-loaded resumes list, an edited nickname actually reaching
 * `updateResumeNickname` (not just the field's own displayed value), the
 * no-op case where the suggestion is left alone, and a first-save
 * nickname collision staying visible instead of being silently swallowed
 * by the post-save collapse.
 */
const getSources = vi.fn();
const createResume = vi.fn();
const listResumes = vi.fn();
const getResults = vi.fn();
const getAllResults = vi.fn();
const updateResumeNickname = vi.fn();
const updateResumeText = vi.fn();

vi.mock("./api/client", () => ({
  getSources: (...args: unknown[]) => getSources(...args),
  createResume: (...args: unknown[]) => createResume(...args),
  listResumes: (...args: unknown[]) => listResumes(...args),
  getResume: () => Promise.reject(new Error("no resume text fetched in this test")),
  getResults: (...args: unknown[]) => getResults(...args),
  getAllResults: (...args: unknown[]) => getAllResults(...args),
  setJobStatus: vi.fn(),
  updateResumeNickname: (...args: unknown[]) => updateResumeNickname(...args),
  updateResumeText: (...args: unknown[]) => updateResumeText(...args),
  estimateSearch: vi.fn(),
  getEstimateProgress: () => Promise.reject(new Error("no progress tracked in this test")),
  startSearch: vi.fn(),
  getSearchStatus: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sessionStorage.clear();
});

const SOURCES: GetSourcesResponse = {
  sources: [{ id: "usajobs", displayName: "USAJOBS", configured: true }],
};
const EMPTY_RESULTS = { results: [] };

function mockBaseline() {
  getSources.mockResolvedValue(SOURCES);
  getAllResults.mockResolvedValue(EMPTY_RESULTS);
  getResults.mockResolvedValue({ resumeId: "resume-3", resumeNickname: "Resume 3", results: [] });
}

describe("App — pre-save nickname suggestion (ticket 3db5b35)", () => {
  it("pre-fills the nickname field with a suggestion derived from the already-loaded resumes list, before any resume is ever saved", async () => {
    mockBaseline();
    listResumes.mockResolvedValue({
      resumes: [
        { id: "resume-1", resumeNickname: "Resume 1", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "resume-2", resumeNickname: "Resume 2", createdAt: "2026-01-02T00:00:00.000Z" },
      ],
    } satisfies ListResumesResponse);

    render(<App />);

    // Before any submission -- no resumeId exists yet, and no createResume
    // call has happened. The suggestion is "Resume 3": one more than the
    // two already-loaded resumes, the same formula the server itself uses
    // (apps/api/src/matching/pipeline.ts's `getOrCreateResumeId`).
    await waitFor(() => expect(screen.getByLabelText("Resume Nickname")).toHaveValue("Resume 3"));
    expect(createResume).not.toHaveBeenCalled();
  });

  // Review finding F2: a failed list load must NOT manufacture a
  // specific, countable guess ("Resume 1") out of a request that told
  // this app nothing about how many resumes actually exist -- for
  // someone who already has a real "Resume 1," that guess produces a
  // server-side 409 collision on a plain, untouched paste. The field
  // stays present (ticket 3db5b35's whole point) but genuinely EMPTY,
  // not silently defaulted.
  it("leaves the nickname field EMPTY, not defaulted to 'Resume 1', when the resumes list fails to load", async () => {
    mockBaseline();
    listResumes.mockRejectedValue(new Error("resumes unavailable"));
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
      isLocked: false,
      isNew: true,
    });

    render(<App />);
    const nicknameField = await screen.findByLabelText("Resume Nickname");

    // Round-2 review finding: an earlier version of this test asserted
    // `toHaveValue("")` immediately after `findByLabelText`, with a comment
    // claiming "the error has had time to resolve by now." It had not.
    // `findBy*` resolves on the FIRST render that satisfies it, which is
    // before the rejected `listResumes` promise has flushed -- so the
    // assertion ran before the seeding effect could possibly have seeded
    // anything, and passed no matter what the effect would have done next.
    //
    // Proven, not supposed: with the F2 defect reintroduced (letting the
    // `error` branch fall through to `existingCount = 0`), the entire web
    // suite stayed GREEN -- 31 files, 397 tests, zero failures. The code was
    // right and nothing was holding it.
    //
    // So wait for the failure to have actually been OBSERVED before
    // asserting the field is still empty. `listResumes` having been called
    // is not enough on its own (the call happens before the rejection
    // settles), so flush the microtask queue the rejection resolves through
    // as well.
    await waitFor(() => expect(listResumes).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // NOW the assertion means something: the list request has failed, the
    // seeding effect has had its chance, and it correctly declined to invent
    // a number out of a response that told this app nothing about how many
    // resumes exist.
    expect(nicknameField).toHaveValue("");

    // And submitting without ever touching the field must not trigger a
    // collision PATCH for a name the user never typed -- `isFirstSave &&
    // isNew` is true here, but `nicknameUserEditedRef` never fires, and
    // `nicknameAtSubmit` is empty, so the reconciliation's length guard
    // alone already skips it.
    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "some resume text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(screen.getByText("Using Resume 1")).toBeInTheDocument());
    expect(updateResumeNickname).not.toHaveBeenCalled();
  });
});

describe("App — an edited pre-save nickname is what actually gets saved (ticket 3db5b35)", () => {
  it("saves the EDITED nickname via updateResumeNickname, not the server's own default -- verified by what the API received, not the field's display", async () => {
    mockBaseline();
    listResumes.mockResolvedValue({ resumes: [] } satisfies ListResumesResponse);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
      isLocked: false,
      isNew: true,
    });
    updateResumeNickname.mockResolvedValue({ id: "resume-1", resumeNickname: "Backend resume" });

    render(<App />);

    // Wait for the suggestion to seed ("Resume 1", 0 existing resumes + 1),
    // THEN edit it -- this is the "pre-populated, but editable before
    // saving" half of the acceptance criteria.
    await waitFor(() => expect(screen.getByLabelText("Resume Nickname")).toHaveValue("Resume 1"));
    fireEvent.change(screen.getByLabelText("Resume Nickname"), {
      target: { value: "Backend resume" },
    });

    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "some resume text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    // THE REAL PROOF: the PATCH body, not what the field happens to show.
    await waitFor(() =>
      expect(updateResumeNickname).toHaveBeenCalledWith("resume-1", "Backend resume"),
    );
    // And the end state reflects it too.
    await waitFor(() => expect(screen.getByText("Using Backend resume")).toBeInTheDocument());
  });

  it("does NOT call updateResumeNickname when the pre-save suggestion is left unedited", async () => {
    mockBaseline();
    listResumes.mockResolvedValue({ resumes: [] } satisfies ListResumesResponse);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
      isLocked: false,
      isNew: true,
    });

    render(<App />);
    await waitFor(() => expect(screen.getByLabelText("Resume Nickname")).toHaveValue("Resume 1"));

    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "some resume text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(screen.getByText("Using Resume 1")).toBeInTheDocument());
    expect(updateResumeNickname).not.toHaveBeenCalled();
  });

  // THE REGRESSION TEST FOR ADVERSARIAL REVIEW FINDING F1 (severe, silent
  // data loss): pasting text that resolves to an ALREADY-SAVED, already
  // user-renamed resume must NOT overwrite that name with the unedited
  // pre-save suggestion, even though the two visibly differ. Before the
  // fix, `nicknameAtSubmit !== defaultNickname` alone was treated as proof
  // of user intent -- which this scenario trivially satisfies without the
  // user ever touching the field.
  it("pasting text for an ALREADY-SAVED resume does not rename it, even though the pre-save suggestion disagrees with its real nickname", async () => {
    mockBaseline();
    // The owner has two real resumes, one of which she renamed herself.
    listResumes.mockResolvedValue({
      resumes: [
        {
          id: "resume-1",
          resumeNickname: "My federal resume",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        { id: "resume-2", resumeNickname: "Resume 2", createdAt: "2026-01-02T00:00:00.000Z" },
      ],
    } satisfies ListResumesResponse);
    // find-or-create resolves to the EXISTING row -- isNew: false is the
    // server's own proof of that, and "My federal resume" is its real,
    // already-chosen nickname, not a fresh default.
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "My federal resume",
      suggestedTitles: [],
      isLocked: false,
      isNew: false,
    });

    render(<App />);
    // The suggestion effect seeds "Resume 3" (two existing resumes + 1) --
    // deliberately NEVER touched by the user below.
    await waitFor(() => expect(screen.getByLabelText("Resume Nickname")).toHaveValue("Resume 3"));

    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "the text of the resume she already saved as 'My federal resume'" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    // THE PROOF: no PATCH ever fires, and the collapsed bar shows her
    // real, chosen name -- not the guess, and not destroyed.
    await waitFor(() => expect(screen.getByText("Using My federal resume")).toBeInTheDocument());
    expect(updateResumeNickname).not.toHaveBeenCalled();
  });

  // A SECOND, SHARPER regression test for F1: this one isolates `isNew`
  // from `nicknameUserEditedRef` specifically, because the coordinator's
  // review called out that a "user typed in this field" flag ALONE is
  // insufficient -- it only fixes the never-touched case covered by the
  // test above. Here the user DOES type a name into the field (so
  // `nicknameUserEditedRef.current` is `true`), AND the paste happens to
  // resolve to an existing, already-named resume (`isNew: false`). Only
  // `isNew` can prevent a rename here; the edited-ref alone would wave it
  // through.
  it("even an EDITED nickname does not get applied when the paste resolves to an existing resume (isNew: false)", async () => {
    mockBaseline();
    listResumes.mockResolvedValue({
      resumes: [
        {
          id: "resume-1",
          resumeNickname: "My federal resume",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    } satisfies ListResumesResponse);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "My federal resume",
      suggestedTitles: [],
      isLocked: false,
      isNew: false,
    });

    render(<App />);
    await waitFor(() => expect(screen.getByLabelText("Resume Nickname")).toHaveValue("Resume 2"));
    // The user DOES type something -- `nicknameUserEditedRef.current`
    // becomes `true` here.
    fireEvent.change(screen.getByLabelText("Resume Nickname"), {
      target: { value: "Something I typed" },
    });

    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "the text of the resume she already saved as 'My federal resume'" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    // Still no PATCH, and her real name survives -- `isNew: false` blocks
    // it even though the user-edited flag alone would not have.
    await waitFor(() => expect(screen.getByText("Using My federal resume")).toBeInTheDocument());
    expect(updateResumeNickname).not.toHaveBeenCalled();
  });

  // A THIRD regression test, isolating `nicknameUserEditedRef` from
  // `isNew` the other way around: a GENUINELY new resume (`isNew: true`)
  // whose pre-save suggestion is simply STALE -- the race the suggestion
  // effect's own comment already names (another tab/session inserting a
  // resume in between the list loading and this submit). The user never
  // touches the field. `isNew` alone is true here, so only the
  // edited-ref can stop an unrequested rename of a resume nobody asked to
  // name anything in particular.
  it("a stale pre-save suggestion on a genuinely NEW resume is not applied either, when the user never touched the field", async () => {
    mockBaseline();
    listResumes.mockResolvedValue({ resumes: [] } satisfies ListResumesResponse);
    // The suggestion will seed "Resume 1" (0 existing + 1), but another
    // session inserted one in between -- the server's real, just-assigned
    // default is "Resume 2", for a row this request DID just create.
    createResume.mockResolvedValue({
      id: "resume-2",
      resumeNickname: "Resume 2",
      suggestedTitles: [],
      isLocked: false,
      isNew: true,
    });

    render(<App />);
    await waitFor(() => expect(screen.getByLabelText("Resume Nickname")).toHaveValue("Resume 1"));
    // Deliberately NOT touched.

    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "some brand new resume text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    // The server's real default stands -- no PATCH tries to force the
    // stale guess onto a resume nobody asked to rename.
    await waitFor(() => expect(screen.getByText("Using Resume 2")).toBeInTheDocument());
    expect(updateResumeNickname).not.toHaveBeenCalled();
  });

  it("a collision on the first-save nickname PATCH surfaces the error and keeps the field's typed value, instead of collapsing to the summary bar", async () => {
    mockBaseline();
    listResumes.mockResolvedValue({ resumes: [] } satisfies ListResumesResponse);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
      isLocked: false,
      isNew: true,
    });
    updateResumeNickname.mockRejectedValue(
      Object.assign(new Error("This resume nickname is already in use."), {
        status: 409,
        body: { error: "This resume nickname is already in use.", reason: "nickname_conflict" },
      }),
    );

    render(<App />);
    await waitFor(() => expect(screen.getByLabelText("Resume Nickname")).toHaveValue("Resume 1"));
    fireEvent.change(screen.getByLabelText("Resume Nickname"), {
      target: { value: "Taken Nickname" },
    });
    expect(screen.getByLabelText("Resume Nickname")).toHaveValue("Taken Nickname");

    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "some resume text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() =>
      expect(updateResumeNickname).toHaveBeenCalledWith("resume-1", "Taken Nickname"),
    );
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not save nickname: This resume nickname is already in use.",
      );
    });
    // Stays visible and editable -- not swallowed by a collapse to "Using
    // Resume 1", and not reverted (same non-reverting treatment a
    // post-save collision already gets).
    expect(screen.getByLabelText("Resume Nickname")).toHaveValue("Taken Nickname");
    expect(screen.getByLabelText("Resume Nickname")).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByText("Using Resume 1")).not.toBeInTheDocument();
  });
});
