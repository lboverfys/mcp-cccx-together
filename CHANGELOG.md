# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may change behaviour).

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
