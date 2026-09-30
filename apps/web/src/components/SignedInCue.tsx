import { useState } from "react";
import { getVerifiedEmail } from "../identity";

/**
 * The quiet "your stuff is saved" indicator (ticket a5c8fa9).
 *
 * WHAT THIS REPLACED, AND WHY. Until ticket a5c8fa9 a verified user got a
 * FLOATING card in the bottom-right corner (`position: fixed`, ticket
 * d3a95d1) reading "These results are saved to <email>. Use a sign-in link
 * from any other browser to see them there." Nicole, dogfooding immediately
 * after verifying her own link: "I'm not crazy about the pop-up that tells
 * you that these results are saved to <her address>. Why don't we just say
 * in the top right of the screen, these results are saved to <her
 * address>... And no pop-up after a successful magic link."
 *
 * The reassurance is the point and is kept -- "are my results actually saved
 * anywhere?" is the question that card existed to answer. What changed is
 * that it is no longer chrome floating over the content.
 *
 * WHY IN THE CONTENT COLUMN RATHER THAN `position: fixed` TO THE VIEWPORT.
 * "Top right of the screen" is satisfied either way, and a fixed element is
 * how this app has repeatedly hurt itself: ticket d3a95d1's review had to
 * add opacity and scroll fixes for a fixed card, then a dismiss button
 * (finding B2) because permanent fixed chrome occluded content with no way
 * to close it, then ticket d0a7074's review found the same card floating
 * over the resume picker where no clearance padding reaches. A label on the
 * `<h1>`'s own row participates in normal layout, so it cannot overlap
 * anything at any viewport width. That also means this component needs no
 * dismiss affordance and no clearance padding, which is what retires B2
 * rather than re-solving it.
 *
 * WHY IT RENDERS NOTHING WHEN ANONYMOUS rather than offering a way to sign
 * in: a returning user whose browser storage is gone currently has no way
 * back into their account at all, which is a real gap -- but it is ticket
 * 5a7e957's gap, and Nicole scoped it out of this one explicitly ("later,
 * when we address the gap that we've already filed a ticket for, we can
 * worry about how they can find those results again"). 5a7e957 will put its
 * "Been here before? Enter your email address" entry point in this same
 * top-right slot, so expect these two to share space.
 *
 * `useState(getVerifiedEmail)` reads local storage ONCE at mount, the same
 * pattern and the same justification as `MagicLinkPrompt`: the only writer
 * is `MagicLinkLanding`, which is a full-page takeover this is never
 * mounted alongside, so the value cannot change underneath a live instance.
 */
export function SignedInCue() {
  const [verifiedEmail] = useState(getVerifiedEmail);

  if (verifiedEmail === undefined) return null;

  return (
    <p className="signed-in-cue">
      {/* Nicole's exact wording. Note it reads slightly oddly on the "My
          Resumes" tab, where no results are on screen -- flagged to her
          rather than silently rewritten, since she chose these words and a
          one-word correction from her beats a unilateral edit. */}
      These results are saved to <strong>{verifiedEmail}</strong>
    </p>
  );
}
