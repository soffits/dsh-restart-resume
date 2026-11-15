# Changelog

## [Unreleased]

## [0.1.0]

### Added

- One scan shortly after DSH starts that continues root sessions and subagents whose last turn a restart cut off (`interrupted`, or `aborted` with cause `disposed`; subagents also with cause `parent` when their parent was shut down at the same moment). Roots get a follow-up message and their active goal armed again; subagents are continued through their parent, and the parent is told which children were continued. Skips stopped turns, scheduled runs, providers that resume their own sessions (`claude-code` by default), archived roots and sessions that keep getting cut right after a resume. Decisions go to `resume.log` in the plugin's state directory.
