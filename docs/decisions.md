# Decisions

## Scope

- **Own plugin, not an existing one.** Compared dsh-neverdie, dsh-continue (anthony1x6000), dsh-auto-continue, dsh-boot-resume, dsh-autocontinue, dsh-recovery-resume and both dsh-resume plugins: none resumes subagents through their parent, several miss the graceful-stop shape (`aborted`/`disposed`), and the larger ones also take over error recovery that a fallback plugin owns. neverdie's tail walk and goal re-arm are the right core and MIT, so they are reused with credit.
- **Turns a plugin started go back to it, by claim.** A scheduler delivers its run's answer and knows whether a later run replaced it, so it keeps the rerun policy; this plugin keeps the finding, from the log. The prompt's `source.principal.kind` says who started a turn; a plugin claims a kind through the `restartResume` service (`ctx.provide`), and the claimer injects only that claim, so neither plugin needs the other to run. Unclaimed principals get the ordinary notice.
- **The scan window is the list's `updatedAt` (creation or last prompt), not the previous process's start.** DSH exposes no last-write time per session, and a subagent's `updatedAt` stays at its first prompt while it works; 0.4.0 filtered on the previous start and missed two working children. Logs are read eight at a time instead, and the after-restart check waits for `last-scan.json` rather than for a fast scan.
- **`last-scan.json` records each scan's outcome**, so a check after a restart reads what was continued, handed over or skipped instead of guessing from timing.

- **One resumer for every provider.** Each provider plugin that resumed its own sessions saw only its model stream: dsh-oh-my-claude marked a session busy per stream, so a turn cut while DSH ran one of its tools was continued by nobody (three claude-code children in one restart). DSH's log records every cut, so this plugin continues all of them, and a provider plugin only reattaches its process (oh-my-claude `resumeAfterRestart: false`). Same shape as durable-execution systems: one recovery owner reading the journal.
- **A short start delay (10 s)**, only for DSH to load sessions and agents; there is no other resumer to wait for.

## Detection

- **Cut kinds**: `interrupted` and `aborted`/`disposed` for any session; `aborted`/`parent` for a subagent only when a shutdown caused it. A user stop of the parent gives children the same cause, and those must stay stopped. The parent's aborted or interrupted turn within 5 s of the child's cut decides (DSH cuts children 25 to 100 ms after the parent); a turn that ended normally cuts no children and is ignored. With none, the parent was idle and DSH's teardown of its tree cut the child (seen in the e2e run: an idle parent's child ends `parent`, not `disposed`), so the cut must lie within 2 minutes of the previous process's stop, which the row records in `stopped.json` when its scope is disposed.
- **Only a new `turn/start` hides a cut.** Inbox splices after the cut are input still waiting (DSH queues a "subagent was stopped" notice on a parent while it stops that parent's children); it does not run by itself and rides along with the resumed turn. neverdie treated any inbox event as activity, which skipped every parent that had a running child.
- **No `blank` filter on the session list**: DSH lists a cold subagent whose only turn never finished as blank.
- **Crash-loop guard per session, not per boot**: a session whose last three turns were each opened by our notice and cut again is left alone. A boot counter would also block deliberate quick restarts.
- **A notice still waiting from an earlier start is not stacked** (its source kind is in the inbox splices after the cut).

- **Jobs killed inside the cut turn are named too**: a model told only that its turn was cut kept waiting on `job_output` for a job that died with DSH.
- **Killed background jobs count as cut work.** A session that ended its turn waiting for a job's report is as stuck after a restart as one cut mid-turn, and no provider plugin wakes it, so these are continued on every provider. Lost means registered before this process started and never settled (DSH's job registry lives in the process; real logs after a graceful restart show no settlement), or settled by teardown within 2 minutes of the recorded stop. A teardown at any other time is DSH disposing the owner (a subagent going idle, an archive), not a restart, and is left alone.
- **Wider listing window for killed jobs** (`jobMaxAgeHours`, 24 h): a session waiting on a long job last wrote when it started it.

## Resuming

- **A child running again by the time its notice would go is skipped**: the scan reads every log before it acts, and a parent or person may re-prompt it meanwhile; that turn already carries the work.
- **Children through `subagents.sendMessage` from the parent Agent**: the public service method, which cold-resumes the child from its descriptor. The host-only prompt path in `dsh-subagent/internal` would keep our own source kind on the child's message, but it is an internal export.
- **Children before roots**, so the root's message can name them; a root that a fast child's report already woke gets the notice steered into that running turn.
- **Goal re-arm through `goals.resume`** after the notice, as neverdie does, instead of asking the model to call `update_goal` (which DSH accepts only from a direct human turn).
- **One scan per process, only within five minutes of process start**: a config edit re-applies the row, and installing the plugin into a long-running DSH is not a restart.
- **Notice source kind `restart-resume`, form `notice`**: DSH's v4 log accepts it (checked in the e2e run), and the streak count finds it.
- **A reload scan keyed on this plugin's own disposal**: the subagent runtime and this plugin both inject `agents` and `sessions`, so a reload that disposes the runtime disposes and re-applies this plugin; the dispose time bounds which cuts are the reload's (30 s before it, for the order the disposals run in). A new hook into the runtime would depend on its internals; this one uses only the injection the plugin already has. Jobs are ignored in that scan: only the subagent runtime restarted, not the process.
