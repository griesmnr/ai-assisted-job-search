// ---------------------------------------------------------------------------
// Shared HTML-to-plain-text handling, used by both greenhouse.ts and
// lever.ts (originally written for Greenhouse's `content` field, lifted out
// here once Lever needed the same tag-stripping for its `lists[].content`
// fields — see lever.ts's `buildDescription`).
//
// This is a lightweight regex-based decode+strip, not a full HTML parser
// (no such dependency is present in this workspace, and job-board HTML is
// simple markup — headings/paragraphs/lists — not a case that needs one).
// It preserves paragraph/list-item breaks as newlines so the result reads
// as text, not a single run-on line.
//
// The two sources' raw markup is NOT encoded the same way, which is why
// this takes a `doubleEncoded` option rather than being a single fixed
// pipeline:
//
//   - Greenhouse entity-encodes the *entire* HTML string for JSON transport
//     (real markup like `<div>` arrives as the literal text `&lt;div&gt;`),
//     on top of the standard HTML entities already present in that markup
//     (`&amp;`, `&nbsp;`, ...). Confirmed on every Greenhouse board checked.
//   - Lever's `lists[].content` is single-encoded ordinary HTML: real `<div>`
//     tags, with only the markup's own entities encoded.
//
// Decoding entities *before* stripping tags is required to recover
// Greenhouse's real markup (`&lt;div&gt;` -> `<div>` -> a tag to strip), but
// doing that same pre-decode on Lever's already-single-encoded content would
// be wrong: a literal `&lt;` sitting in ordinary body text (someone typed
// "score &lt; 5" into a job posting) would decode to a literal `<`, and then
// get eaten by the tag-stripping pass as if it were the start of a tag,
// silently corrupting real content. `doubleEncoded: false` (the default)
// skips that pre-decode step and strips tags directly off the raw markup,
// which is the correct pipeline for content that was only ever encoded once.
// ---------------------------------------------------------------------------

const BLOCK_BOUNDARY_TAGS = /<\/(?:p|div|li|ul|ol|h[1-6])\s*>|<br\s*\/?>/gi;
const ANY_TAG = /<[^>]*>/g;
const NUMERIC_DEC_ENTITY = /&#(\d+);/g;
const NUMERIC_HEX_ENTITY = /&#x([0-9a-fA-F]+);/g;

/** Decodes one layer of HTML entity encoding. `&amp;` is handled last so it
 * doesn't re-trigger the other replacements (standard unescape ordering —
 * avoids turning an intentional literal `&amp;lt;` into `<` instead of the
 * literal text `&lt;` it represents). */
function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(NUMERIC_DEC_ENTITY, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(NUMERIC_HEX_ENTITY, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&amp;/g, "&");
}

export type HtmlToPlainTextOptions = {
  /**
   * Set for Greenhouse-style content, where the whole HTML string is itself
   * entity-encoded on top of the markup's own entities, so a decode pass is
   * needed before tag-stripping to reveal the real tags at all. Leave false
   * (the default) for ordinary single-encoded HTML like Lever's, where
   * pre-decoding would wrongly turn literal `&lt;`/`&gt;` body text into
   * characters that then get mistaken for tag delimiters and stripped.
   */
  doubleEncoded?: boolean;
};

/**
 * Strips HTML markup down to plain text, decoding entities along the way.
 * See this file's top-of-file comment for why `doubleEncoded` exists and
 * which sources need which setting.
 */
export function htmlToPlainText(raw: string, options: HtmlToPlainTextOptions = {}): string {
  const { doubleEncoded = false } = options;

  // Only Greenhouse-style content needs this first decode pass to reveal
  // its real markup (`&lt;div&gt;` -> `<div>`) before tags can be stripped.
  const html = doubleEncoded ? decodeHtmlEntities(raw) : raw;
  // Turn block-level boundaries into line breaks before stripping tags, so
  // paragraphs/list items don't get smashed into one continuous line.
  const withBreaks = html.replace(BLOCK_BOUNDARY_TAGS, "\n");
  const stripped = withBreaks.replace(ANY_TAG, "");
  // The markup's own ordinary HTML entities (`&amp;`, `&nbsp;`, ...) are
  // still literal text at this point regardless of `doubleEncoded` — decode
  // them into the actual characters they represent. For single-encoded
  // content this is the only decode pass; for Greenhouse it's the second of
  // two layers.
  const plainText = decodeHtmlEntities(stripped);

  return plainText
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}
