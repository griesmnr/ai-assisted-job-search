<!-- rtk-instructions v2 -->
# RTK (Rust Token Killer) - Token-Optimized Commands

## Golden Rule

**Always prefix commands with `rtk`**. If RTK has a dedicated filter, it uses it. If not, it passes through unchanged. This means RTK is always safe to use.

**Important**: Even in command chains with `&&`, use `rtk`:
```bash
# ❌ Wrong
git add . && git commit -m "msg" && git push

# ✅ Correct
rtk git add . && rtk git commit -m "msg" && rtk git push
```

## RTK Commands by Workflow

### Build & Compile (80-90% savings)
```bash
rtk cargo build         # Cargo build output
rtk cargo check         # Cargo check output
rtk cargo clippy        # Clippy warnings grouped by file (80%)
rtk tsc                 # TypeScript errors grouped by file/code (83%)
rtk lint                # ESLint/Biome violations grouped (84%)
rtk prettier --check    # Files needing format only (70%)
rtk next build          # Next.js build with route metrics (87%)
```

### Test (60-99% savings)
```bash
rtk cargo test          # Cargo test failures only (90%)
rtk go test             # Go test failures only (90%)
rtk jest                # Jest failures only (99.5%)
rtk vitest              # Vitest failures only (99.5%)
rtk playwright test     # Playwright failures only (94%)
rtk pytest              # Python test failures only (90%)
rtk rake test           # Ruby test failures only (90%)
rtk rspec               # RSpec test failures only (60%)
rtk test <cmd>          # Generic test wrapper - failures only
```

### Git (59-80% savings)
```bash
rtk git status          # Compact status
rtk git log             # Compact log (works with all git flags)
rtk git diff            # Compact diff (80%)
rtk git show            # Compact show (80%)
rtk git add             # Ultra-compact confirmations (59%)
rtk git commit          # Ultra-compact confirmations (59%)
rtk git push            # Ultra-compact confirmations
rtk git pull            # Ultra-compact confirmations
rtk git branch          # Compact branch list
rtk git fetch           # Compact fetch
rtk git stash           # Compact stash
rtk git worktree        # Compact worktree
```

Note: Git passthrough works for ALL subcommands, even those not explicitly listed.

### GitHub (26-87% savings)
```bash
rtk gh pr view <num>    # Compact PR view (87%)
rtk gh pr checks        # Compact PR checks (79%)
rtk gh run list         # Compact workflow runs (82%)
rtk gh issue list       # Compact issue list (80%)
rtk gh api              # Compact API responses (26%)
```

### JavaScript/TypeScript Tooling (70-90% savings)
```bash
rtk pnpm list           # Compact dependency tree (70%)
rtk pnpm outdated       # Compact outdated packages (80%)
rtk pnpm install        # Compact install output (90%)
rtk npm run <script>    # Compact npm script output
rtk npx <cmd>           # Compact npx command output
rtk prisma              # Prisma without ASCII art (88%)
rtk uv run <cmd>        # Compact uv project command output
```

### Files & Search (60-75% savings)
```bash
rtk ls <path>           # Tree format, compact (65%)
rtk read <file>         # Code reading with filtering (60%)
rtk grep <pattern>      # Search grouped by file (75%). Format flags (-c, -l, -L, -o, -Z) run raw.
rtk find <pattern>      # Find grouped by directory (70%)
```

### Analysis & Debug (70-90% savings)
```bash
rtk err <cmd>           # Filter errors only from any command
rtk log <file>          # Deduplicated logs with counts
rtk json <file>         # JSON structure without values
rtk deps                # Dependency overview
rtk env                 # Environment variables compact
rtk summary <cmd>       # Smart summary of command output
rtk diff                # Ultra-compact diffs
```

### Infrastructure (85% savings)
```bash
rtk docker ps           # Compact container list
rtk docker images       # Compact image list
rtk docker logs <c>     # Deduplicated logs
rtk kubectl get         # Compact resource list
rtk kubectl logs        # Deduplicated pod logs
```

### Network (65-70% savings)
```bash
rtk curl <url>          # Compact HTTP responses (70%)
rtk wget <url>          # Compact download output (65%)
```

### Meta Commands
```bash
rtk gain                # View token savings statistics
rtk gain --history      # View command history with savings
rtk discover            # Analyze Claude Code sessions for missed RTK usage
rtk proxy <cmd>         # Run command without filtering (for debugging)
rtk init                # Add RTK instructions to CLAUDE.md
rtk init --global       # Add RTK to ~/.claude/CLAUDE.md
```

## Token Savings Overview

| Category | Commands | Typical Savings |
|----------|----------|-----------------|
| Tests | vitest, playwright, cargo test | 90-99% |
| Build | next, tsc, lint, prettier | 70-87% |
| Git | status, log, diff, add, commit | 59-80% |
| GitHub | gh pr, gh run, gh issue | 26-87% |
| Package Managers | pnpm, npm, npx | 70-90% |
| Files | ls, read, grep, find | 60-75% |
| Infrastructure | docker, kubectl | 85% |
| Network | curl, wget | 65-70% |

Overall average: **60-90% token reduction** on common development operations.
<!-- /rtk-instructions -->

---

# Development Workflow

This project is run as an AI software team. Claude acts as **project manager**:
it owns the ticket backlog, dispatches implementation agents, gates every merge
behind adversarial review, and performs the merges itself.

## Project Stack

> **STATUS: NOT YET DETERMINED.** The repository currently contains no
> application code — only `SETUP_HISTORY.md` (environment provisioning notes)
> and this file. The stack will be fixed during the project interview and this
> section replaced with concrete build/test/lint commands.

Toolchains available in the container today:

| Tool | Version |
|---|---|
| Go | 1.22.2 (linux/arm64) |
| Node | 22.23.2 |
| pnpm | 10.33.0 |
| Python | 3.12.3 |
| git-bug | installed (`git-bug`, `git bug`) |
| RTK | installed |

Not installed: `cargo`, `docker` CLI, `gh`. Adding any of these is itself a
ticket, not an ad-hoc action.

Once the stack is chosen, this section must list, explicitly:

- the build command, the test command, the lint/format command
- how to run the project locally
- the definition of done for a ticket (which of the above must pass)

## Model Roster and Escalation Ladder

Capability ladder, weakest to strongest:

```
haiku-4.5  →  sonnet-5  →  opus-5  →  fable-5
```

Selection policy:

- **Default to the weakest model that can do the job.** Most implementation
  work is `sonnet`.
- `haiku` — mechanical, fully specified edits: renames, formatting, moving
  files, boilerplate scaffolds, single-line fixes.
- `sonnet` — the workhorse. Normal feature implementation, tests, refactors,
  documentation, and most reviews.
- `opus` — **only when the extra capability is actually needed**: cross-cutting
  architecture, subtle concurrency or correctness reasoning, tricky debugging,
  security-sensitive code, or reviewing a `sonnet` change.
- `fable` — reserved for the hardest reasoning on the board, and for reviewing
  `opus` work.

"Because it's important" is not a reason to escalate. Escalate when the task is
*hard*, not when it is *high-stakes* — high stakes are handled by the review
gate, not by burning a stronger model on the first draft.

## git-bug Ticket Conventions

All design issues, implementation tasks, and bugs live in git-bug. Nothing gets
implemented without a ticket.

```bash
git-bug bug new -t "TITLE" -m "BODY" --non-interactive
git-bug bug label new <BUG_ID> "label"
git-bug bug                       # list open tickets
git-bug bug show <BUG_ID>
git-bug bug status close <BUG_ID>
```

### Required labels

Every ticket carries **exactly one** of each of the first three:

| Namespace | Values |
|---|---|
| `type:` | `design`, `task`, `bug`, `chore`, `docs` |
| `difficulty:` | `trivial`, `easy`, `moderate`, `hard`, `research` |
| `model:` | `haiku`, `sonnet`, `opus`, `fable` |

Optional: `area:<component>`, `epic` (a parent that must be split), `blocked`.

`difficulty:` and `model:` are set by the PM at ticket creation and are a
*standing decision* — the dispatched agent runs on the labelled model. If an
agent reports that a ticket was mislabelled, the PM re-labels it and re-dispatches
rather than letting the agent escalate itself.

### Ticket body template

```
## Context
Why this exists; link to the design ticket it came from.

## Scope
What is in. What is explicitly out.

## Acceptance criteria
- [ ] concrete, checkable statements
- [ ] including which tests must pass

## Notes
Files likely touched, gotchas, prior art.
```

### Splitting

Break larger tickets into smaller tickets whenever practical. A ticket is too
big if it cannot be stated as a single coherent change with acceptance criteria
that fit in a short list. Label the parent `epic`, create children, and reference
the parent ID in each child's Context. Epics are never implemented directly.

## Parallel Work: Git Worktrees

Every ticket is implemented in its own worktree on its own branch. Agents never
work in `/workspace` directly and never touch `main`.

```bash
rtk git worktree add ../wt-<bug-id-short> -b ticket/<bug-id-short>-<slug>
# ... agent works there ...
rtk git worktree remove ../wt-<bug-id-short>
```

Branch naming: `ticket/<short-bug-id>-<kebab-slug>`.

Rules:

- One ticket, one worktree, one branch.
- Before dispatching parallel tickets, the PM checks they do not touch
  overlapping files. Overlapping tickets are serialized, not parallelized.
- Worktrees are removed after merge or abandonment. No stale worktrees.

## Agent Orchestration

- **Maximum 4–6 agents in flight at any one time.** Prefer 4; go to 6 only when
  the tickets are genuinely independent and small.
- **Every agent's `description` must explicitly name the model it runs on**, in
  the form `[model] short description` — e.g. `[sonnet] implement config loader`,
  `[opus] adversarial review auth`.
- The `model` parameter passed to the Agent tool must match both the description
  and the ticket's `model:` label.
- Each agent prompt states: the bug ID, its worktree path and branch, the
  acceptance criteria, and the instruction to commit on that branch only.
- Agents do not merge. Agents do not create tickets. Agents report back.

## Adversarial Review Gate

**No branch merges without adversarial review by the next stronger appropriate
model.** This is not optional and not skippable for "small" changes.

| Implemented by | Reviewed by |
|---|---|
| `haiku` | `sonnet` |
| `sonnet` | `opus` |
| `opus` | `fable` |
| `fable` | `opus` (independent peer — top of ladder) |

The reviewer is *adversarial*: its job is to find reasons the change should not
merge, not to bless it. The review prompt must ask for, at minimum:

- correctness failures with a concrete failing scenario
- unmet or falsely-claimed acceptance criteria
- missing test coverage for the change's own edge cases
- scope creep beyond the ticket
- a clear verdict: **MERGE**, **MERGE WITH FIXES**, or **REJECT**, with reasons

The reviewer runs in the implementer's worktree and reads the actual diff
(`rtk git diff main...HEAD`). A review that only reads the agent's summary is
not a review.

## Merge Authority

**Claude, as PM, makes the final merge decision and performs the merge.** Not
the implementing agent, not the reviewer — their output is advice.

The PM merges only when all of the following hold:

1. Acceptance criteria are met, verified against the diff — not against the
   agent's self-report.
2. The adversarial review returned MERGE, or returned MERGE WITH FIXES and the
   fixes have been made and re-reviewed.
3. Build, tests, and lint pass (once the stack defines them).
4. The diff is within the ticket's scope.

Merge procedure:

```bash
rtk git merge --no-ff ticket/<branch>     # from main, in /workspace
rtk git worktree remove ../wt-<id>
git-bug bug status close <BUG_ID>
```

`--no-ff` always: the merge commit is the audit record of the review decision.

If the PM rejects, the ticket goes back to open with the reviewer's findings
appended as a git-bug comment. Rejections are recorded, not silently retried.

## Reporting

Test failures, review rejections, and abandoned work are reported to the user
plainly, with the output. A ticket is "done" only when merged and closed.
