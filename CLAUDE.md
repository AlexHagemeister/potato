# Potato: agent instructions

Potato is a web app for deciding what to watch, one card at a time. Read [VISION.md](VISION.md) before any work. Its operating clause binds: when an implementation choice fights an invariant, stop and surface it. When a tool does not fit, drop the tool, not the invariant.

This file holds stable rules. It changes rarely. Add to the Notes section at the bottom only for a lasting quirk a future agent would otherwise rediscover the hard way.

## Starting a session

Before any work, orient from the record:

1. Read VISION.md.
2. Read the founding record: `gh pr view 1`.
3. Read recent history: `git log --oneline -20`, plus the PR bodies of merges that touch your area.
4. Check open work: `gh pr list`, and `gh issue list --label needs-alex --state all`. Alex answers needs-alex issues in their threads. An answer there is a ruling, so act on new ones first.
5. Check the `v1` milestone for anything Alex has added.

## Roles

- **Alex** owns VISION.md and every product call. He does not read code or review PRs. He judges the app by using it on his iPhone.
- **Agents** build, review, and merge. The project history lives in git and GitHub (PRs, issues, one milestone), not in files.

## Stack

- Next.js (App Router), TypeScript in strict mode, deployed on Vercel (Hobby plan). Functions use the Node runtime.
- Bun for installs, scripts, and tests.
- Postgres on Neon.
- Google sign-in through an auth library that stores users and sessions in our own Postgres. Pick the library from its current docs, not from memory. No hosted auth service.
- Movie and series data from the TMDB API.
- IMDb ratings from IMDb's non-commercial dataset (`title.ratings.tsv.gz`, refreshed daily by IMDb), loaded into Postgres on a daily schedule.
- Installable to the iPhone home screen (web app manifest, standalone display).

## Architecture rules

1. **A title's identity is (media type, TMDB ID).** Movie and series IDs come from separate pools, so an ID alone is ambiguous. Every table, cache key, and URL uses the pair.
2. **One row per user per title, with one status:** `watchlist`, `passed`, `seen`, or `skipped`. A skipped row carries the date it returns to the deck. A seen row carries the rating (0.5 to 10 in 0.5 steps) and the optional review. A database constraint enforces one row per user per title.
3. **All app logic lives in one core layer.** The UI and the API call it. Neither holds logic of its own. The core layer does not import UI or framework code. This is what lets the future MCP do anything the app does (VISION invariant 7).
4. **Each external service has exactly one module,** with caching: one for TMDB, one for IMDb. TMDB publishes no fixed rate limit, so the TMDB module handles HTTP 429 responses.
5. **The deck engine is a pure function.** Input: the user's lists, the filters, and the discovery mode. Output: an ordered list of titles. It has unit tests.
6. **Reviews carry a visibility field, default private.** Nothing is public yet. The field keeps the social direction open (VISION invariant 9).
7. **Attribution is mandatory.** The Profile tab shows the TMDB logo and the notice "This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB." Every place that shows streaming availability credits JustWatch as the data source. The Profile tab also shows IMDb's required statement for its ratings: "Information courtesy of IMDb (https://www.imdb.com). Used with permission." TMDB revokes API access for non-compliance, and IMDb can withdraw permission at any time.
8. **Secrets never enter git.** `.env.local` holds them. `.env.example` lists every variable with no values.

## How work happens

- **No upfront backlog.** Work from VISION.md. All work belongs to the GitHub milestone `v1`. Its close condition: Alex has used the app on his phone and ruled. Only Alex closes it.
- **Phase 0 before any feature code:** the app skeleton, CI (typecheck, lint, tests, build), the Neon database, Google sign-in, and a green production deploy on Vercel.
- **One slice, one branch, one PR.** The PR body says what changed and why, lists each judgment call with its reason and what would justify reversing it, and shows how the change was verified, with a screenshot at iPhone viewport for any UI change.
- **Verify in the running app,** not only in tests: Playwright at an iPhone viewport (390 by 844), plus the Vercel preview deployment for the PR.
- **Use the app, don't just look at it.** Once the UI exists, verify any PR that touches a flow by driving that flow end to end in a browser at 390 by 844: tap through each step and check the result after each tap. A screenshot alone does not count. The PR body names each flow walked and what was checked.
- **Walk every flow at each phase boundary:** the end of phase 0, after each major feature, and before the milestone handoff. A fresh agent with no build context uses the app the way Alex would: sign in, sort a dozen cards with each button, undo, rate and review, search, filter, change settings, then reload and confirm everything persisted. Each break becomes a fix before more feature work, or a needs-alex issue if it is a product call.
- **Behind sign-in, use a development-only test session.** Agents cannot sign in to Google as Alex. A test login exists only in development and is disabled in production builds.
- **Review every PR with a fresh agent.** The agent that built the PR never reviews it. A subagent with no build context reviews it:
  1. It invokes the `code-review` skill at `high` effort on the PR number, with `--comment`, so findings land on the PR as comments.
  2. It reads VISION.md and comments on any invariant the PR fights.
  3. The builder fixes each finding or answers it in the PR thread with a reason.
  4. A fresh reviewer re-checks only the fixes. It reads the diff since the commit the last review checked, confirms each finding is fixed or that the builder's answer holds (in the running app when the finding was seen there), and checks that the changed code broke nothing nearby. It does not rerun the full `code-review` skill. It posts its result as one PR comment that names the head commit it checked. Why: full re-reviews re-read code that was already checked and took 10 to 20 minutes a round (Alex, 2026-11-07).
  5. After three rounds without a clean review, label the PR `needs-alex` and move on to other work.
- **Small fixes get a lighter review.** A PR is small when it fixes one bug, changes under about 150 lines, and touches no core rule, database schema, or sign-in code. Its fresh reviewer reads the diff and runs the tests instead of the full `code-review` skill, and walks only the one flow the fix touches. If the reviewer finds anything risky, the PR goes back to the full review. Why: full reviews of small fixes took most of each fix's hour (Alex, 2026-11-07).
- **A reviewer's pass has to mean something.** A fresh reviewer tends to stop at the first checks that come back green. So the builder tells the reviewer what the change must do, and the reviewer goes looking for where it fails: the whole test suite, the edges of the flow, an input that should be refused. How deep to go is the reviewer's call, scaled to what the change could break. Why: Alex never reads code, so a pass is the only signal he gets, and a verifier with no criteria declares success early (Anthropic's multi-agent guidance, read 2026-11-10).
- **Split work by context, not by role.** One agent carries a slice from code through tests to its own walk, because each handoff loses what the last agent knew. A second agent earns its cost when it needs none of that context (a review, a walk) or when its work is truly separate. Slices that would touch the same code go one after another. Why: extra agents cost several times the tokens and buy coverage, not speed (same guidance, Alex 2026-11-10).
- **Merge** with a squash merge once the review is clean and CI is green. Delete the branch.
- **Before handing the milestone to Alex,** a fresh subagent reviews the whole codebase against VISION.md, and its findings go through the same fix loop.
- **Use CLIs and APIs, never dashboards:** `gh`, `vercel`, and the Neon CLI or Neon MCP. Ask Alex only for what needs his hands: sign-ins, consent screens, account creation, API keys.

## Deciding without Alex

Agents run unattended, often overnight. Triage each open question:

- **Local and reversible** (naming, layout details, a library swap inside one module): decide, and record the call in the PR body.
- **Architecturally significant** (hard to reverse, broad in reach, or in conflict with a VISION invariant): do not decide. Open an issue labeled `needs-alex` with the question, the options, and a recommendation. Then continue with other work that does not depend on the answer.
- **Stale text goes with the change.** When Alex approves a change, the same PR updates every line it makes stale (in VISION.md, CLAUDE.md, code comments, copy, and tests) without a separate ask, and the PR body lists each one. Why: stale text misleads the next agent, and Alex counts those edits as part of the change he approved (Alex, 2026-11-08).
- **A bug found outside the PR that caused it gets an issue** labeled `bug`. The fixing PR says `Fixes #N` and states the symptom, the root cause, and how the fix was verified. A bug caught and fixed inside its own PR before merge needs no issue: the review thread and PR body already hold it.
- **Work noticed outside the current slice gets an issue,** so it outlives the session that noticed it. This is discovered work, not a backlog: never file issues for planned features from VISION.md.
- **A report to the orchestrator is not a record.** Anything above that exists only in a subagent's report gets filed before the orchestrator moves on.

State lives in GitHub. Do not create status, progress, or tracking files in the repo.

## Environment notes

- **This repo is public.** Nothing personal goes into code, commits, PRs, or issues.
- **Agents post through Alex's GitHub account, so every agent-written comment, issue, and PR body opens with "Agent:".** Only comments without that marker are Alex's rulings.
- **Alex's exocortex vault** (`~/exocortex`, also reachable through its MCP) holds his preferences and context. Read it when useful. Never write to it from this project, and never copy personal details from it into this repo.
- **The permission classifier.** Claude Code's auto-mode classifier sometimes denies or stalls routine commands. Run file moves (`mv`, `git mv`) as standalone commands, never chained with `&&` or `;`. When a command is denied or hangs, split it and retry once before treating it as a bug.

## Notes

Lasting quirks discovered during the build go here, one line each, with the date.

- 2026-11-07: `.env.local` points at the production database. `.env.development.local` overrides only the database variables, pointing them at `potato_dev`. The Next dev server loads both and the dev file wins, so a new worktree needs both copied. Any other local database tool or script takes its connection from `.env.development.local`, never from `.env.local`.
- 2026-11-07: Walk as your own test user, never the shared one: open `/api/dev/login?as=<slug>` (for example `?as=pr90`; 1 to 24 lowercase letters, digits, and inner dashes) to sign in as `dev-test-<slug>@example.com`, created on first use. Plain `/api/dev/login` is the shared user other agents may be using.
- 2026-11-07: `bun run dev:user show <slug>` counts that user's rows in each list (potato_dev only, read only).
- 2026-11-07: `bun run dev:user reset <slug>` deletes that user's title rows and settings so a walk starts clean, and keeps it signed in. It refuses any database but potato_dev, and the shared user needs `--shared` in place of a slug.
- 2026-11-07: `bun run dev:user seed <slug>` writes two real titles to each list (Watchlist, Passed, Seen with ratings and a review, Skipped), creating the user if needed. It overwrites that user's rows for those eight titles and keeps its other rows. Run `reset` first for exactly those eight rows.
- 2026-11-07: `bun run dev:user delete <slug>` deletes the user and everything it owns. Run it when your walk is done.
