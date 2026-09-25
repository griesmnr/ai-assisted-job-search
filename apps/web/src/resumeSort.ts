/**
 * Natural/numeric-aware sort by `resumeNickname` -- extracted out of
 * ResumeInput.tsx's "Change" picker (ticket 336f1e6, Nicole: "the numbers
 * are seriously hopping around weirdly for me") so MyResumes.tsx (ticket
 * 7da6904, same complaint applied to the My Resumes tab: "go ahead and
 * make them alphanumeric on the resume page too") can sort identically
 * without the two call sites drifting out of sync.
 *
 * `numeric: true` is load-bearing, not optional: a plain `localeCompare`
 * sorts "Resume 10" before "Resume 2" (lexicographic), which is exactly
 * the "hopping around" Nicole flagged. Returns a NEW array -- never
 * mutates `resumes` in place, since both call sites pass down the SAME
 * array reference App.tsx holds in `resumesListState.data.resumes`
 * (`.sort()` on that reference in place would silently reorder whichever
 * OTHER consumer of that same array renders next).
 */
export function sortResumesByNickname<T extends { resumeNickname: string }>(resumes: T[]): T[] {
  return [...resumes].sort((a, b) =>
    a.resumeNickname.localeCompare(b.resumeNickname, undefined, { numeric: true }),
  );
}
