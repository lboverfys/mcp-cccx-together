# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may change behaviour).

## [Unreleased]

### Changed

- **Read and verify tasks are accepted automatically.** `review` now defaults to `auto` for `read` and `verify` tasks (write tasks keep the 0.3.0 rule: `auto` only with `verify`). These tasks change no files, so manual review only made Codex redo the investigation before anything downstream could start. Pass `review: "codex"` to keep the old behaviour.
- **Auto-accepted read and verify workers are closed.** Their processes are released right after acceptance, so Codex no longer calls `team_close`. Follow-ups use `team_resume`, which reopens the same Claude Code session.
- **`team_wait` returns the full report.** A stopped worker's `summary` now holds up to 6,000 characters of its report, filled in from the stored result when the 2,000-character summary was cut. `summaryTruncated: true` marks longer reports. Without `workerIds`, `team_wait` also returns, once, any result Codex has not yet seen, such as one that finished and was auto-accepted between two waits.
- **Shorter, checkable worker reports.** Worker instructions ask for at most 1,500 characters: the answer first, up to five pieces of `file:line` or command-output evidence, verified facts kept apart from guesses, and no unsupported likelihood rankings.
- **Server instructions set the division of labour.** Codex is told not to investigate what it has delegated, to do a narrow lookup itself and delegate only independent sub-questions, to split broad work into non-overlapping parallel workers, and to use reports without redoing them.

### Added

- **`explore` task option.** A read task with `explore: true` may use Claude Code's Explore sub-agent for parallel searches. A hook keeps both the worker and its sub-agents on Read/Glob/Grep and blocks other agent types and nesting.

## [0.3.0]

### Added

- **Worktree isolation for write tasks.** In a git repository, each write task runs in its own git worktree. The worktree starts from a snapshot of the main working tree, including uncommitted and untracked files. `verify` runs inside the worktree. On acceptance, only in-scope changes are merged back into the working tree, with a three-way merge when the same files changed meanwhile. Nothing is staged or committed. New task fields: `isolation` and `links`.
- **Scope enforcement.** File-editing tools (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) refuse paths outside the task's `scope`, including in the default `bypassPermissions` mode. Out-of-scope changes block acceptance; auto review sends them back to the worker.
- **`team_diff` tool.** Shows an isolated task's unmerged changes, out-of-scope files, a stat and a paged patch, for review before acceptance.
- **Providers.** Named Anthropic-compatible providers (for example DeepSeek) in the config file. `env` holds non-secret values; `envFrom` copies secrets from existing variables. Tasks pick one with `provider`; `defaultProvider` / `CC_TEAM_DEFAULT_PROVIDER` sets a default. Results from other providers carry `costReliable: false`, and `maxBudgetUsd` triggers a warning.
- `setup` writes `tool_timeout_sec` into Codex's config and registers a 570-second `team_wait`. It forwards provider credential variables through `env_vars`, and falls back to the 50-second default if the config can't be edited.
- `prune` lists worktrees of closed workers and removes the ones with no unmerged changes.
- `CHANGELOG.md`, `SECURITY.md` and issue templates.

### Changed

- **`review` default.** It is now `auto` only when the task has a `verify` command, otherwise `codex`. A worker's own "done" no longer releases downstream tasks unchecked. Write tasks must provide `verify` to use `auto`.
- Worker names may be up to 24 characters including the `cc` suffix (was 10).
- When an upstream result summary is cut at 2,000 characters, downstream instructions mark it as truncated and tell the worker to read the full result first.
- The server version is read from `package.json`.
- Internals: verification, path helpers, dependency graph and isolation moved out of `manager.mjs` into their own modules.

### Fixed

- `team_wait` could miss a worker whose process exited (crash or failed start) between two waits. It could then report `done: true` while that worker had failed. Such workers are now reported with `attention: true` until they are resumed or closed.

### Upgrade notes

- Tasks without `verify` now wait for `team_review`. To keep the old behaviour for read-only tasks, pass `"review": "auto"`.
- Write tasks in git repositories now change your files only when accepted. Pass `"isolation": "shared"` for the old in-place behaviour.
- Keep `stateDir` outside your repositories; isolation refuses to start otherwise.
- Re-run `setup` (after `codex mcp remove cc_team`) to get the longer wait and provider forwarding.

## [0.2.0]

First public release: Codex coordinates local Claude Code workers through MCP, with dependency scheduling, scope-aware queueing, automatic `verify`, durable state, resume, `prune`/`recover` maintenance and cross-platform CI.
