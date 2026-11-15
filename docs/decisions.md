# Decisions

## Scope

- **Own plugin, not an existing one.** Compared dsh-neverdie, dsh-continue (anthony1x6000), dsh-auto-continue, dsh-boot-resume, dsh-autocontinue, dsh-recovery-resume and both dsh-resume plugins: none resumes subagents through their parent, several miss the graceful-stop shape (`aborted`/`disposed`), and the larger ones also take over error recovery that a fallback plugin owns. neverdie's tail walk and goal re-arm are the right core and MIT, so they are reused with credit.
- **Providers that resume their own sessions are skipped** (`skipProviders`, default `claude-code`): dsh-oh-my-claude knows when a Claude process it kept alive through the restart has finished, and a second notice from here would land in a busy CLI.
- **Scheduled runs are skipped**: the scheduler that started a run owns rerunning it, and only it knows whether a later run already replaced it.

## Detection

- **Cut kinds**: `interrupted` and `aborted`/`disposed` for any session; `aborted`/`parent` for a subagent only when a shutdown caused it. A user stop of the parent gives children the same cause, and those must stay stopped. The parent's aborted or interrupted turn within 5 s of the child's cut decides (DSH cuts children 25 to 100 ms after the parent); a turn that ended normally cuts no children and is ignored. With none, the parent was idle and DSH's teardown of its tree cut the child (seen in the e2e run: an idle parent's child ends `parent`, not `disposed`), so the cut must lie within 2 minutes of the previous process's stop, which the row records in `stopped.json` when its scope is disposed.
- **`parent`-cut subagents are ours on every provider, `skipProviders` included**: dsh-oh-my-claude interrupts such a child's Claude (to it the abort looks like a user stop of the parent) and keeps no mark of it, so it never wakes the child after the restart (seen in the e2e run with a real Claude child).
- **Only a new `turn/start` hides a cut.** Inbox splices after the cut are input still waiting (DSH queues a "subagent was stopped" notice on a parent while it stops that parent's children); it does not run by itself and rides along with the resumed turn. neverdie treated any inbox event as activity, which skipped every parent that had a running child.
- **No `blank` filter on the session list**: DSH lists a cold subagent whose only turn never finished as blank.
- **Crash-loop guard per session, not per boot**: a session whose last three turns were each opened by our notice and cut again is left alone. A boot counter would also block deliberate quick restarts.
- **A notice still waiting from an earlier start is not stacked** (its source kind is in the inbox splices after the cut).
- **Provider** is the one in the session's last `request/header`, the route the cut turn actually ran on.

## Resuming

- **Children through `subagents.sendMessage` from the parent Agent**: the public service method, which cold-resumes the child from its descriptor. The host-only prompt path in `dsh-subagent/internal` would keep our own source kind on the child's message, but it is an internal export.
- **Children before roots**, so the root's message can name them; a root that a fast child's report already woke gets the notice steered into that running turn.
- **Goal re-arm through `goals.resume`** after the notice, as neverdie does, instead of asking the model to call `update_goal` (which DSH accepts only from a direct human turn).
- **One scan per process, only within five minutes of process start**: a config edit re-applies the row, and installing the plugin into a long-running DSH is not a restart.
- **Notice source kind `restart-resume`, form `notice`**: DSH's v4 log accepts it (checked in the e2e run), and the streak count finds it.
