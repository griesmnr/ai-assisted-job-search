import { describe, expect, it } from "vitest";
import { sortResumesByNickname } from "./resumeSort";

/**
 * Tickets 336f1e6/7da6904: the shared natural/numeric sort both
 * ResumeInput.tsx's "Change" picker and MyResumes.tsx now use.
 */
describe("sortResumesByNickname", () => {
  it("sorts numerically, not lexicographically -- 'Resume 2' before 'Resume 10'", () => {
    const input = [
      { resumeNickname: "Resume 1" },
      { resumeNickname: "Resume 14" },
      { resumeNickname: "Resume 2" },
      { resumeNickname: "Resume 10" },
    ];

    expect(sortResumesByNickname(input).map((r) => r.resumeNickname)).toEqual([
      "Resume 1",
      "Resume 2",
      "Resume 10",
      "Resume 14",
    ]);
  });

  it("does not mutate the input array", () => {
    const input = [{ resumeNickname: "Resume 2" }, { resumeNickname: "Resume 1" }];
    const original = [...input];

    sortResumesByNickname(input);

    expect(input).toEqual(original);
  });

  it("sorts custom nicknames alongside numbered ones sensibly (case-insensitive collation)", () => {
    const input = [
      { resumeNickname: "Senior SWE" },
      { resumeNickname: "Resume 14" },
      { resumeNickname: "backend v2" },
      { resumeNickname: "Resume 2" },
    ];

    expect(sortResumesByNickname(input).map((r) => r.resumeNickname)).toEqual([
      "backend v2",
      "Resume 2",
      "Resume 14",
      "Senior SWE",
    ]);
  });
});
