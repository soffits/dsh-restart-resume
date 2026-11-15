# dsh-restart-resume

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that continues the turns a DSH restart cut off, subagents included. Without it, every session that was working when DSH stopped sits there until someone types "continue", and a subagent cut off mid-task never comes back at all.

It adds no tools and no UI. Shortly after DSH starts (60 seconds by default, so other plugins resume their own sessions first) it looks once at the sessions that changed in the last two hours and continues the ones whose last turn was cut off by DSH going away:

- **Root sessions** get a follow-up message in their own session saying the turn was cut off, asking the model to continue and to check the effects of a cut-off tool call before running it again. An active goal, which DSH disarms when it loads a session, is armed again.
- **Subagents** can't be resumed that way: DSH refuses to load one on its own ("owned by subagent routing"). Each gets its message from its parent instead (`subagents.sendMessage`), which brings the child back on its own model and preset. It then reports to its parent when it finishes, as it would have.
- A parent continued at the same time is told in its own message which of its subagents were continued, so it waits for their results instead of sending them the task again. A parent that is already running (another plugin resumed it) gets the same line in its running turn.

A turn counts as cut off when it ended `interrupted` (DSH died) or `aborted` with cause `disposed` (DSH stopped), and no turn has started in the session since. A subagent whose turn ended with cause `parent` is continued only when DSH's stop did that: its parent's turn was cut off by the same shutdown, or its parent was idle and the cut lies at the moment the previous DSH process stopped (the plugin notes that moment as DSH stops). A parent stopped by hand also stops its children, and those stay stopped.

Left alone on purpose:

- Turns someone stopped, and turns a fallback plugin handed to another model.
- Sessions on a provider listed in `skipProviders`. The default is `claude-code`, because [dsh-oh-my-claude](https://github.com/lcestou/dsh-oh-my-claude) resumes those itself after a restart. The exception is a subagent cut with cause `parent`: its provider sees only an abort from the parent, the same as a stop by hand, so it is resumed from here on every provider.
- Runs started by the scheduler (message source `schedule`), which reruns its own cut-off runs.
- Archived root sessions.
- A session that was cut off again right after each of its last three resumes, so a turn that keeps taking DSH down doesn't loop.
- Anything when the plugin is installed or enabled into a DSH that has been running for more than five minutes: there is no restart to recover from.

Every decision is written to `resume.log` in `~/.local/state/dsh-restart-resume` (or `$XDG_STATE_HOME/dsh-restart-resume`, or `DSH_RESTART_RESUME_STATE_DIR`), next to `stopped.json`, the time DSH last stopped.

## Install

```sh
dsh plugin --profile web add @soffits/dsh-restart-resume
```

The bundle adds one host row, `restart-resume`. It takes effect at the next DSH start.

## Settings

| Key | Default | |
|---|---|---|
| `enabled` | `true` | Scan after start. |
| `delaySeconds` | `60` | Seconds after start before the scan. |
| `maxAgeMinutes` | `120` | A turn cut off longer ago than this is left alone. |
| `maxResumes` | `3` | A session cut off again this many times in a row right after a resume is left alone. |
| `skipProviders` | `[claude-code]` | Providers whose sessions another plugin resumes. |
| `resumeGoals` | `true` | Arm a resumed session's active goal again. |

For example, in a profile patch:

```yaml
- id: restart-resume
  config:
    delaySeconds: 30
```

## Limits

A subagent whose parent is itself a subagent can only be reached through a session DSH won't load directly, so it is not resumed. A tool call that was halfway through when DSH stopped may have had side effects; the message asks the model to check, but the plugin can't know. External subagents (ACP agents, Claude Code's own `Agent` tool) have no DSH session to continue.

## Credits

The tail detection and the goal re-arm follow [dsh-neverdie](https://github.com/pinion05/dsh-neverdie) by pinion05 (MIT).

## License

MIT
