# Maintainer notes

A DeepSeek Harness host plugin: one scan per DSH process, shortly after start, that continues the turns a restart cut off. No tools, no client part. Users read `README.md`; this file and `docs/` are for whoever changes the code.

## Layout

- `index.js`: the plugin row. Config schema, the once-per-process guard, the timer, and the narrowed DSH services handed to the scan.
- `src/detect.js`: pure rules on one session's header and events (was the last turn cut by a shutdown, is anything newer, which provider, scheduled or not, the resume streak, did the parent shut down too). No DSH imports, so the tests run it on plain fixtures.
- `src/resume.js`: the scan. Lists sessions, judges each, continues children through their parent and roots in their own session, tells parents.
- `src/state.js`: the state directory and the decision log.
- `test/fixtures/*.json`: real session logs, anonymised (content, tool data and ids replaced), cut at the moment DSH next started.
- `tools/e2e.mjs`: the end-to-end check against a real DSH in a throwaway `DSH_HOME` under `.e2e/`, with a scripted OpenAI-compatible model.

## Checks

- `npm run check` (syntax) and `npm test` (unit tests) run in CI on Node 22 and 24.
- `node tools/e2e.mjs term` and `node tools/e2e.mjs kill` need the `dsh` CLI on PATH and run a few minutes each; run both before a release that touches detection or the scan. They never touch a real `DSH_HOME`; keep it that way (a second DSH on a live profile can take over that profile's running work). `--keep` leaves the run directory for reading the session logs.
- When DSH changes its session log format or the subagent service, take a fresh fixture from a real cut: the shapes in the tests are what DSH wrote, not what its docs say.

## Rules for changes

- Detection reads only what DSH writes; no matching on message text. The plugin's own notices are recognised by their source kind (`restart-resume`).
- A rule that skips a session logs why, in one line, to `resume.log`.
- Waiting inbox input after a cut is not activity (DSH queues one for a parent while it stops that parent's children); a new `turn/start` is.
- Children are continued before their parents, so a parent's message can name them.

## Working on the project

- Everything in the repo (code, docs, commits) is English.
- Ordinary implementation choices are yours: decide, write the choice and its one-line reason in `docs/decisions.md` (replacing any line it supersedes, no dates), and mention it in your report. Product decisions (what gets resumed, scope) belong to the maintainers; ask about those.
- If a requested approach looks weaker than an alternative, say so with the reason before building it.
- Report each state separately: implemented, tested (which checks, which real run), committed, pushed, CI. Say plainly what was not verified.
- Commit on a branch as you go. Merge to `main`, tag, release or publish only when the task asks for it.
- Work only in this checkout, on the current branch. Temporary files go under `.e2e/` (git-ignored) and are removed when done.

## Long work

- For work longer than a few steps, keep `docs/progress/<task>.md`: the goal, what is done, decisions, what is next. Update it after each meaningful step so a fresh session resumes without redoing work. When the work merges, move what lasts into `docs/decisions.md` and `docs/queue.md` and delete the file.
- Leftovers and known bugs go into `docs/queue.md` the moment you find them, not into a promise in your report.

## Before building

- Before writing any non-trivial component, search for maintained libraries and other DSH plugins that already do it. Check the licence (MIT/Apache/BSD/CC0 to ship; GPL and unlicensed work only as ideas), upkeep, and that it runs on our DSH version. Adopt, adapt or write our own, and record why in `docs/decisions.md`.
- Take versions of DSH, Node and dependencies from current official sources, not memory.

## Code

- No backward compatibility while the project has no users: when a format or name changes, change it everywhere and delete the old one.
- Few general mechanisms, no special cases. Define each list, limit or constant once.
- Reproduce a bug before fixing it, preferably as a fixture from the session log that showed it.
- If a test can't pass, explain why in the progress file. Never loosen or move an assertion to make it green.
- No dead code, commented-out code or bare `TODO`; unfinished work is in `docs/queue.md`.

## Git

- Conventional Commits, one-line subjects, a body only when the why isn't obvious. The repo's local author identity is set on purpose.
- Squash merges. Whoever merges a branch deletes it (`gh pr merge --squash --delete-branch`) and runs `git fetch --prune`.
- In GitHub Actions, reference well-known actions by major tag (`@v4`), not by commit SHA.
- Releases: move the `Unreleased` part of `CHANGELOG.md` under the new version's heading, bump the version, squash-merge to `main` (`feat: <summary> (vX.Y.Z)`), and once CI is green on that commit, tag `vX.Y.Z` and publish to npm from `main`.
