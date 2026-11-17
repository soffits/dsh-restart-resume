# Changelog

## [Unreleased]

## [0.5.0]

### Added

- A scan after a profile reload: when the row is applied again in a running DSH (the subagent runtime was reloaded with it and every running subagent stopped), it continues the turns cut since it was disposed, with a notice that says a reload cut them. Setting `resumeAfterReload` (default on).

## [0.4.1]

### Fixed

- 0.4.0 read only sessions whose listed `updatedAt` fell after the previous process started, but DSH lists a session's creation or last prompt there, not its last write: subagents working for longer than the previous process were never read and not continued. The window is back to `jobMaxAgeHours`; logs are read eight at a time.

## [0.4.0]

### Added

- `restartResume` service: a plugin that starts turns under its own principal kind (a scheduler) claims that kind, and the scan hands such cut turns to it instead of sending a notice. dsh-cron-jobs 0.13.0 claims `cron-job`. Unclaimed scheduled runs now get the ordinary notice (they were skipped).
- `last-scan.json` in the state directory: when the scan ran and what it continued, handed over and skipped.

### Changed

- The scan reads only sessions that wrote while the previous DSH process ran, so it finishes in seconds instead of reading every session changed in a day.
- Background jobs the cut turn itself was waiting on are named in the notice as killed.

## [0.3.0]

### Changed

- Cut turns are continued on every provider; `skipProviders` is gone. A provider plugin sees only its own model stream, so a turn cut while DSH was running one of its tools was left to a provider that never saw the cut (dsh-oh-my-claude left three such claude-code subagents idle in one restart). Pair it with dsh-oh-my-claude's `resumeAfterRestart: false`, so that plugin only reattaches its Claude processes.
- `delaySeconds` defaults to 10 (was 60): nothing else resumes first any more.
- The notice says tool calls that failed while DSH was down work again.

### Fixed

- A subagent that was re-prompted after the scan read its log is no longer sent the notice on top.

## [0.2.0]

### Added

- Sessions that were waiting on background jobs the restart killed are continued too, with a message naming each lost job, even when their last turn had ended normally, on every provider; subagents through their parent as before. A job counts as lost when it was registered before the new process started and never settled, or settled by DSH's teardown at the recorded stop. New setting `jobMaxAgeHours` (24): how far back a session's last write may lie for this check, since a long wait writes nothing while it runs.

## [0.1.1]

### Fixed

- A subagent cut with cause `parent` is now continued when its parent was idle at the stop, not only when the parent's own turn was cut: DSH's teardown cuts an idle parent's running children that way. The plugin records when DSH stops (`stopped.json`) and checks the cut against it. A parent turn that ended normally just before no longer counts as the cause.
- Such subagents are continued on every provider, also those in `skipProviders` (`claude-code` by default), since that provider cannot tell a shutdown from a stop by hand and does not resume them.

## [0.1.0]

### Added

- One scan shortly after DSH starts that continues root sessions and subagents whose last turn a restart cut off (`interrupted`, or `aborted` with cause `disposed`; subagents also with cause `parent` when their parent was shut down at the same moment). Roots get a follow-up message and their active goal armed again; subagents are continued through their parent, and the parent is told which children were continued. Skips stopped turns, scheduled runs, providers that resume their own sessions (`claude-code` by default), archived roots and sessions that keep getting cut right after a resume. Decisions go to `resume.log` in the plugin's state directory.
