# 0001. Per-user config as an overlay outside `Config`

- Status: accepted
- Date: 2026-11-08

## Context
Several Telegram users need their own sources, delivery chat and digest frequency on top of the shared `data/config.github.json` (task 001, issue #10). The repo is a fork of upstream Horizon: changes to upstream files (`src/models.py`, `src/storage/manager.py`) cause merge conflicts on every sync. All users run in GitHub Actions on one hourly cron and share the Groq keys.

## Options
- A: New fields in `Config` (`src/models.py`) and a per-user `config.json`. Plus: one model, one loader. Minus: edits an upstream model, so every upstream sync risks conflicts; a full config per user duplicates `ai`, `processing`, `digest`, `webhook`.
- B: Separate `UserConfig` in `src/users/` (`extra="forbid"`), applied to the base `Config` by `apply_overlay` that returns a new `Config`. Plus: upstream files untouched except for hook points in `src/main.py` and `src/orchestrator.py`; shared settings stay in one place. Minus: two models to keep in sync with each other; overlay fields are not visible in `Config`.
- Sources merge: union of base and user sources vs full replacement. Union makes it impossible to drop a base source and mixes users' feeds; replacement is predictable.
- Frequency: arbitrary `time_window_hours` with per-user last-run state vs only divisors of 24 scheduled by `hour % N == 0`. State needs storage between Actions runs; divisors of 24 are stateless and give an even schedule.

## Decision
We will use option B: `UserConfig` lives outside `Config` and is applied by `apply_overlay`. User `sources` fully replace the base ones when present, otherwise the base sources are used. `time_window_hours` must be a positive divisor of 24, and a user is due when `hour % time_window_hours == 0`.

## Consequences
- Upstream syncs touch only small hook points in `src/main.py` and `src/orchestrator.py`.
- A new per-user setting needs a field in `UserConfig` and a line in `apply_overlay`; if upstream renames a `Config` field used there, `apply_overlay` breaks and is covered by `tests/test_users.py`.
- Users cannot pick windows like 5 or 7 hours; the window is both the collection window and the digest frequency.
- Users who want base sources plus a few extra must copy the base list into their file.
