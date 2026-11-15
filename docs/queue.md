# Queue

- A subagent whose parent is itself a subagent is not resumed (DSH loads neither directly). Would need the grandparent to message the parent first; rare at DSH's default delegation depth of 1.
- First boot after upgrading from 0.1.x: `stopped.json` has no `started`, so every job registered before boot counts as the previous process's. On 2026-11-15 this woke five idle subagents over jobs an older restart had killed 2.5 h earlier; they found nothing lost and finished. One-time per upgrade and harmless; a fix would take the previous start from the oldest turn the previous stop cut, or treat jobs older than the window before `previousStop` as stale.
