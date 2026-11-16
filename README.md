# dsh-restart-resume

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that continues the turns a DSH restart cut off, subagents included. Without it, every session that was working when DSH stopped sits there until someone types "continue", and a subagent cut off mid-task never comes back at all.

It adds no tools and no UI. Shortly after DSH starts (10 seconds by default, once DSH has loaded its sessions) it looks once at the sessions that changed recently and continues the ones whose last turn was cut off by DSH going away, or whose background jobs it killed:

- **Root sessions** get a follow-up message in their own session saying the turn was cut off, asking the model to continue and to check the effects of a cut-off tool call before running it again. An active goal, which DSH disarms when it loads a session, is armed again.
- **Subagents** can't be resumed that way: DSH refuses to load one on its own ("owned by subagent routing"). Each gets its message from its parent instead (`subagents.sendMessage`), which brings the child back on its own model and preset. It then reports to its parent when it finishes, as it would have.
- A parent continued at the same time is told in its own message which of its subagents were continued, so it waits for their results instead of sending them the task again. A parent that is already running again (a child's report or a person woke it) gets the same line in its running turn. A child someone continued between the scan reading it and reaching it is left alone.

- **Sessions that were waiting on background jobs** the restart killed get a message too, even when their last turn had ended normally. DSH keeps its jobs in the process, so a restart kills every running one (an `until` loop waiting for CI, a `gh run watch`, a long build) and its report never comes; a session that ended its turn waiting for that report would otherwise wait forever. The message names each lost job and asks the model to check what it was doing and start again what still matters. 

A turn counts as cut off when it ended `interrupted` (DSH died) or `aborted` with cause `disposed` (DSH stopped), and no turn has started in the session since. A job counts as killed by the restart when it was registered before the new process started and never settled, or settled by DSH's teardown at the moment the previous process stopped. A subagent whose turn ended with cause `parent` is continued only when DSH's stop did that: its parent's turn was cut off by the same shutdown, or its parent was idle and the cut lies at the moment the previous DSH process stopped (the plugin notes that moment as DSH stops). A parent stopped by hand also stops its children, and those stay stopped.

Left alone on purpose:

- Turns someone stopped, and turns a fallback plugin handed to another model.
- Archived root sessions.
- A session that was cut off again right after each of its last three resumes, so a turn that keeps taking DSH down doesn't loop.
- Anything when the plugin is installed or enabled into a DSH that has been running for more than five minutes: there is no restart to recover from.

A turn a plugin started under its own name (a scheduler's run: the prompt's `source.principal`) goes back to that plugin when it has claimed that kind of principal, since only it can deliver the run's answer and know whether the run is still worth finishing. It claims through this plugin's `restartResume` service:

```js
ctx.inject(['restartResume'], (sub) => {
  const drop = sub.restartResume.claim('cron-job', async ({ sessionId, principal, cut, jobs }) => {
    // rerun the job's cut turn, or not
    return { continued: true } // or { continued: false, why: 'the next run is due soon' }
  })
  sub.effect(() => drop)
})
```

[dsh-cron-jobs](https://github.com/soffits/dsh-cron-jobs) 0.13.0 and later claims its `cron-job` runs this way. A cut turn whose principal nobody claimed gets the ordinary notice.

Background jobs the restart killed are named in the notice, also the ones the cut turn itself was waiting on, so the model starts them again instead of waiting on a report that never comes.

Only sessions that wrote while the previous DSH process ran are read (what that process cut or killed, it wrote to), so the scan takes seconds. When it is done it writes `last-scan.json` next to `resume.log`: `boot`, `startedAt`, `doneAt`, and the session ids it continued (`roots`, `children`), handed to their owner (`claimed`), and left alone with a reason (`skipped`, `{ id, why }`). A check after a restart reads that record rather than racing the scan.

Every decision is written to `resume.log` in `~/.local/state/dsh-restart-resume` (or `$XDG_STATE_HOME/dsh-restart-resume`, or `DSH_RESTART_RESUME_STATE_DIR`), next to `stopped.json`, the time DSH last stopped.

Every provider is handled the same way, because only DSH's session log sees every cut: a provider plugin sees its own model stream, and a turn cut while DSH was running one of the turn's tools has no stream open. A provider plugin that keeps its process alive through a restart should only reattach it and leave continuing the turn to this plugin; for [dsh-oh-my-claude](https://github.com/lcestou/dsh-oh-my-claude) that is `resumeAfterRestart: false` (from the version that has the switch). The notice tells the model that tool calls which failed while DSH was down work again.

## Install

```sh
dsh plugin --profile web add @soffits/dsh-restart-resume
```

The bundle adds one host row, `restart-resume`. It takes effect at the next DSH start.

## Settings

| Key | Default | |
|---|---|---|
| `enabled` | `true` | Scan after start. |
| `delaySeconds` | `10` | Seconds after start before the scan. |
| `maxAgeMinutes` | `120` | A turn cut off longer ago than this is left alone. |
| `maxResumes` | `3` | A session cut off again this many times in a row right after a resume is left alone. |
| `resumeGoals` | `true` | Arm a resumed session's active goal again. |
| `jobMaxAgeHours` | `24` | A session that last wrote longer ago than this is not checked for killed jobs (a long wait writes nothing while it runs). |

For example, in a profile patch:

```yaml
- id: restart-resume
  config:
    delaySeconds: 20
```

## Limits

A subagent whose parent is itself a subagent can only be reached through a session DSH won't load directly, so it is not resumed. A tool call that was halfway through when DSH stopped may have had side effects; the message asks the model to check, but the plugin can't know. External subagents (ACP agents, Claude Code's own `Agent` tool) have no DSH session to continue. A subagent's background jobs end with its turn in DSH (the subagent service closes an idle child and disposes its jobs), so a child that ended its turn to wait for one is not woken by it, restart or not; that is DSH's behaviour, not a restart, and this plugin leaves it alone.

## Credits

The tail detection and the goal re-arm follow [dsh-neverdie](https://github.com/pinion05/dsh-neverdie) by pinion05 (MIT).

## License

MIT
