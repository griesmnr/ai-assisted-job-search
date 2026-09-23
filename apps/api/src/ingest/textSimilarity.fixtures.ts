/**
 * Realistic-shaped job descriptions used to CALIBRATE the cross-source
 * duplicate threshold (ticket 78d31b7), not just to exercise the code.
 *
 * They live in their own module rather than inline in a test file because
 * two test files need them: `textSimilarity.test.ts` measures the algorithm
 * against them, and `crossSourceDedup.test.ts` drives real ingests with
 * them, so the end-to-end behavior is proven on the SAME text the threshold
 * was chosen from.
 *
 * Shape matters here. Each one is built the way real postings are: a
 * company-wide "About" block, a role-specific middle, and company-wide
 * compensation and EEO blocks. That shared boilerplate is the whole
 * difficulty — it is what makes two genuinely different reqs at one company
 * look alike — so a fixture without it would make this check look far more
 * accurate than it is.
 */

/** The same req, as an employer pastes it into ATS #1. */
export const SAME_REQ_ATS_A = `
About Northwind Robotics

Northwind Robotics builds autonomous material-handling systems for
warehouses. We were founded in 2019, we are profitable, and we ship
hardware and software to customers in eleven countries. Our engineering
team is 40 people and growing.

The Role

We are looking for a Senior Software Engineer to join the Fleet Platform
team. You will design and build the services that coordinate hundreds of
robots operating in a single facility, including task assignment, traffic
management, and the APIs our customers integrate against. This is a
backend-heavy role with real distributed systems problems: our schedulers
have to keep making good decisions when a network partition splits a
warehouse in half.

What you will do

Design, build, and operate backend services in Go and TypeScript. Own
features end to end, from a design document through rollout and
monitoring. Work directly with the robotics team to turn fleet behavior
requirements into service contracts. Improve our deployment and
observability story as the fleet grows. Mentor engineers earlier in their
careers through code review and design review.

What we are looking for

Five or more years building and operating production backend services.
Strong fundamentals in concurrency, data modeling, and API design.
Experience with message-driven architectures and the failure modes that
come with them. Comfort with ambiguity: many of these problems do not
have an established playbook. Excellent written communication, because we
are a distributed team and we write things down.

Compensation and benefits

The salary range for this role is 180,000 to 225,000 USD, plus equity.
We offer full medical, dental, and vision coverage, a 401k with match,
twenty days of paid time off plus company holidays, and a home office
stipend.

Northwind Robotics is an equal opportunity employer. We do not
discriminate on the basis of race, religion, color, national origin,
gender, sexual orientation, age, marital status, veteran status, or
disability status.
`;

/**
 * The IDENTICAL req as the same employer pastes it into ATS #2: two
 * sections retitled, two sentences reworded. This is what "the same job on
 * two platforms" actually looks like — employers rarely paste byte-
 * identical text twice, so a check that only catches exact copies would
 * catch almost nothing.
 */
export const SAME_REQ_ATS_B = `
About Northwind Robotics

Northwind Robotics builds autonomous material-handling systems for
warehouses. We were founded in 2019, we are profitable, and we ship
hardware and software to customers in eleven countries. Our engineering
team is 40 people and growing.

The Role

We are hiring a Senior Software Engineer for the Fleet Platform team. You
will design and build the services that coordinate hundreds of robots
operating in a single facility, including task assignment, traffic
management, and the APIs our customers integrate against. This is a
backend-heavy role with real distributed systems problems: our schedulers
have to keep making good decisions when a network partition splits a
warehouse in half.

Responsibilities

Design, build, and operate backend services in Go and TypeScript. Own
features end to end, from a design document through rollout and
monitoring. Work directly with the robotics team to turn fleet behavior
requirements into service contracts. Improve our deployment and
observability story as the fleet grows. Mentor engineers earlier in their
careers through code review and design review.

Requirements

Five or more years building and operating production backend services.
Strong fundamentals in concurrency, data modeling, and API design.
Experience with message-driven architectures and the failure modes that
come with them. Comfort with ambiguity: many of these problems do not
have an established playbook. Excellent written communication, since we
are a distributed team and we write things down.

Compensation and benefits

The salary range for this role is 180,000 to 225,000 USD, plus equity.
We offer full medical, dental, and vision coverage, a 401k with match,
twenty days of paid time off plus company holidays, and a home office
stipend.

Northwind Robotics is an equal opportunity employer. We do not
discriminate on the basis of race, religion, color, national origin,
gender, sexual orientation, age, marital status, veteran status, or
disability status.
`;

/**
 * A GENUINELY DIFFERENT req at the same company, with the same title, in
 * the same city — the owner's own stated worry (98844f1). Shares every
 * boilerplate section verbatim (About, Compensation, EEO are company-wide
 * copy) and differs only in the part that says what the job is.
 *
 * This is the fixture that matters most. A naive company+title+location
 * implementation merges this with SAME_REQ_ATS_A and silently deletes a
 * real opening from the user's results.
 */
export const DIFFERENT_REQ_SAME_COMPANY = `
About Northwind Robotics

Northwind Robotics builds autonomous material-handling systems for
warehouses. We were founded in 2019, we are profitable, and we ship
hardware and software to customers in eleven countries. Our engineering
team is 40 people and growing.

The Role

We are looking for a Senior Software Engineer to join the Perception
team. You will own the vision stack that lets our robots understand the
space around them: camera calibration, depth estimation, pallet and
obstacle detection, and the training pipelines behind those models. This
is a hands-on role at the boundary of computer vision and embedded
systems, and you will spend real time on the warehouse floor with the
hardware.

What you will do

Build and tune perception models in Python and C++ that run on constrained
onboard compute. Own the data pipeline: collection, labeling workflows,
augmentation, and evaluation against field failures. Work with the
hardware team on camera and lidar selection and placement. Take models
from a notebook to something that runs at frame rate on a robot in a cold
warehouse. Investigate perception failures reported from the field and
turn them into regression cases.

What we are looking for

Five or more years of applied computer vision or machine learning
experience, including production deployment on embedded or edge hardware.
Fluency in Python and C++. Experience with camera calibration and
multi-sensor fusion. A track record of debugging model failures against
real sensor data rather than benchmarks. Willingness to travel to
customer sites roughly once a quarter.

Compensation and benefits

The salary range for this role is 180,000 to 225,000 USD, plus equity.
We offer full medical, dental, and vision coverage, a 401k with match,
twenty days of paid time off plus company holidays, and a home office
stipend.

Northwind Robotics is an equal opportunity employer. We do not
discriminate on the basis of race, religion, color, national origin,
gender, sexual orientation, age, marital status, veteran status, or
disability status.
`;

/**
 * THE KNOWN FALSE-MERGE CASE (ticket 78d31b7, review F2a). A HEAVILY
 * TEMPLATED employer: two genuinely different reqs where the ATS template
 * supplies everything except one "The Role" paragraph — the About block, the
 * responsibilities, the requirements, compensation and EEO are all
 * company-wide copy pasted verbatim into both.
 *
 * This one DOES merge at the shipped 0.65 threshold (measured 0.676,
 * 2026-09-23). It is here precisely because it merges: `DESCRIPTION_
 * SIMILARITY_THRESHOLD`'s doc comment used to describe the false-merge
 * region as needing "more than ~70% verbatim shared boilerplate", implying
 * nothing realistic reaches it. This fixture is 75.5% verbatim shared
 * boilerplate (77 role-specific tokens of 314) and is entirely realistic —
 * plenty of employers write exactly one bespoke paragraph per req. See that
 * doc comment for the corrected narrative.
 *
 * Deliberately derived from `SAME_REQ_ATS_A` rather than written out again,
 * so "only the role paragraph differs" is guaranteed by construction instead
 * of by careful copy-editing. `textSimilarity.test.ts` asserts the
 * substitution actually happened.
 */
const THE_ROLE_SECTION = /The Role[\s\S]*?\n\nWhat you will do/;

export const TEMPLATED_COMPANY_DIFFERENT_REQ = SAME_REQ_ATS_A.replace(
  THE_ROLE_SECTION,
  THE_ROLE_SECTION.exec(DIFFERENT_REQ_SAME_COMPANY)?.[0] ?? "",
);

/** The same req as ATS_A, with the second platform's own footer appended. */
export const SAME_REQ_WITH_PLATFORM_FOOTER =
  SAME_REQ_ATS_A +
  `

Apply for this job

Northwind Robotics uses this platform to manage applications. By applying
you agree to its terms of service and privacy policy. Questions about this
posting can be sent to careers@northwind.example.
`;

/** The same req, with the compensation block dropped — realistic for an
 * ATS that renders pay as structured fields rather than body text. */
export const SAME_REQ_WITHOUT_COMPENSATION = SAME_REQ_ATS_A.replace(
  /Compensation and benefits[\s\S]*?stipend\./,
  "",
);

/** The most distorted TRUE duplicate measured: reworded, compensation
 * dropped, platform footer added. This is what sets the threshold's upper
 * bound. */
export const SAME_REQ_MAXIMALLY_DISTORTED =
  SAME_REQ_ATS_B.replace(/Compensation and benefits[\s\S]*?stipend\./, "") +
  `

Apply on this platform. Questions to careers@northwind.example.
`;

/** Two postings with nothing whatsoever in common — the easy case. */
export const UNRELATED_POSTING = `
Line Cook - Evening Shift

Harbor House is a 90-seat seafood restaurant on the waterfront. We are
hiring a line cook for evening service, Wednesday through Sunday. You
will work the saute and grill stations, handle prep during the afternoon,
and keep your station clean and stocked through close. Two years of
professional kitchen experience preferred. Pay is 24 to 28 dollars per
hour depending on experience, plus a share of the tip pool. Meals
included on shift.
`;
