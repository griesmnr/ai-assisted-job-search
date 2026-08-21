import { describe, expect, it } from "vitest";
import { htmlToPlainText } from "./html.js";

// ---------------------------------------------------------------------------
// Direct tests on the shared helper itself, not just through greenhouse.ts's
// (doubleEncoded: true) or lever.ts's (doubleEncoded: false) call sites.
//
// This closes a real gap: an adversarial review flipped this file's default
// (`doubleEncoded = false` -> `= true`) and every existing greenhouse.test.ts
// + lever.test.ts test (75 of them) still passed, because none of them
// exercised single-encoded content (Lever's `lists[].content`) against a
// string containing a literal `&lt;`/`&gt;` in ordinary body text — the one
// case where getting the flag backwards silently corrupts content instead of
// just leaving stray markup behind. That is the exact failure mode this file
// exists to prevent (see its top-of-file comment), so it needs its own test
// that would catch the flag being reversed, independent of either source's
// fixtures.
// ---------------------------------------------------------------------------

describe("htmlToPlainText — doubleEncoded option", () => {
  it("with doubleEncoded left at its default (false/single-encoded, correct for Lever), strips real tags and decodes a literal entity in body text without corrupting it", () => {
    // "score &lt; 5" is single-encoded body text (a person typed a literal
    // "<" into a job posting, which is what "&lt;" it as ordinary HTML) --
    // exactly Lever's encoding. Under the correct (default) pipeline, the
    // real <li> tags get stripped and the literal &lt; decodes to a literal
    // "<" with the rest of the text intact.
    const input = "<li>score &lt; 5</li><li>then this</li>";

    expect(htmlToPlainText(input)).toBe("score < 5\nthen this");
  });

  it("passing doubleEncoded: true on that same single-encoded input corrupts it -- demonstrating why the flag must be threaded through correctly, not defaulted blindly", () => {
    // If this ever changes to pass (e.g. someone "simplifies" away the
    // option, or flips the default), it means the corrupting pre-decode
    // pass is silently eating content again -- the regression this test
    // exists to catch. Decoding &lt; before stripping tags turns "&lt; 5"
    // into a literal "<" that reads as the start of a new tag; the tag
    // stripper then greedily consumes everything from that stray "<" through
    // the next real ">" it finds (the closing ">" of the second <li>),
    // silently deleting "< 5" and "then " along with it.
    const input = "<li>score &lt; 5</li><li>then this</li>";

    expect(htmlToPlainText(input, { doubleEncoded: true })).toBe("score then this");
  });

  it("with doubleEncoded: true (correct for Greenhouse), recovers real markup from double-encoded content before stripping it", () => {
    // Greenhouse's actual encoding: the whole HTML string is itself
    // entity-encoded, so a real <div> tag arrives as the literal text
    // "&lt;div&gt;". Only the doubleEncoded: true pipeline decodes that
    // outer layer before stripping tags -- the default (false) pipeline
    // leaves "&lt;div&gt;" as inert literal text (nothing looks like a real
    // tag to strip) and only partially resolves the doubled-up "&amp;amp;"
    // (one decode pass turns it into "&amp;", not "&").
    const input = "&lt;div&gt;hello &amp;amp; goodbye&lt;/div&gt;";

    expect(htmlToPlainText(input, { doubleEncoded: true })).toBe("hello & goodbye");
    expect(htmlToPlainText(input, { doubleEncoded: false })).toBe("<div>hello &amp; goodbye</div>");
  });

  it("returns empty string for empty input under either setting", () => {
    expect(htmlToPlainText("")).toBe("");
    expect(htmlToPlainText("", { doubleEncoded: true })).toBe("");
  });
});
