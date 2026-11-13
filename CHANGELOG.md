# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may change behaviour).

## [Unreleased]

### Changed

- **`team_dispatch` waits for results by default.** It returns what `team_wait` returns once the batch has stopped or a worker needs a decision, so a delegation costs Codex one call instead of two. Pass `wait: false` for the old immediate return.
- **Server instructions set the division of labour, assuming Codex is the slow side.** Codex hands over everything that needs reading code, searching, running commands or editing, and doesn't investigate first or alongside a worker. It writes the clues it already has into short prompts, gives each independent question its own worker, and passes reports on instead of redoing or rewriting them. Write tasks may use `scope: ["."]` and `verify: "auto"` when the files and test command aren't known yet. Investigations that need commands, git history or logs use `verify` tasks. Overall testing after several writes is a command task in the same batch. Codex merges several reports itself instead of dispatching a summary worker, which only added another serial Claude Code run. When an image has a local path, Codex passes the path, since workers can read images. The instructions are also shorter.
- **Isolated writes run in parallel.** A worktree write task doesn't touch the working tree until it is merged, so read tasks and other worktree write tasks with overlapping scopes run alongside it. Before, any two write tasks with overlapping scopes ran one after another, so with `scope: ["."]` all writes were serial. Verify tasks and shared-mode writers still wait.
- **Merge conflicts go back to the worker, not to Codex.** When an isolated result conflicts with changes merged meanwhile, the server merges the current working tree into the worker's worktree with conflict markers, moves its starting point forward, and sends the conflicted files to the same worker (counted against `maxFixRounds` under auto review). `team_review` does the same and returns `sentBack: true` instead of an error.
- **Workers may use sub-agents by default.** `explore` now defaults to `true` for every task: read and verify tasks may use the read-only Explore sub-agent, write tasks also general-purpose sub-agents, whose edits are bound to the task's scope by the same hook. Sub-agents cannot nest. Codex doesn't read the code before delegating, so it rarely knew when to turn this on. Pass `explore: false` for the old behaviour.
- **Workers ask Codex less.** Every `ask_parent` costs a slow Codex turn, so workers ask only when an action is destructive or a wrong guess would waste the work; otherwise they go with the most reasonable reading and state the assumption in the report.
- **Auto-accepted read and verify workers no longer hold up `team_wait`.** The result is returned as soon as it is accepted, without waiting for the process to exit.
- **Write tasks started together share one snapshot.** Creating several worktrees in the same scheduling pass takes one full snapshot of the working tree instead of one per task.
- **Read and verify tasks are accepted automatically.** `review` now defaults to `auto` for `read` and `verify` tasks (write tasks keep the 0.3.0 rule: `auto` only with `verify`). These tasks change no files, so manual review only made Codex redo the investigation before anything downstream could start. Pass `review: "codex"` to keep the old behaviour.
- **Auto-accepted read and verify workers are closed.** Their processes are released right after acceptance, so Codex no longer calls `team_close`. Follow-ups use `team_resume`, which reopens the same Claude Code session.
- **`team_wait` returns the full report.** A stopped worker's `summary` now holds up to 6,000 characters of its report, filled in from the stored result when the 2,000-character summary was cut. `summaryTruncated: true` marks longer reports. Without `workerIds`, `team_wait` also returns, once, any result Codex has not yet seen, such as one that finished and was auto-accepted between two waits.
- **Shorter, checkable worker reports.** Worker instructions ask for at most 1,500 characters: first an answer Codex can pass to the user as-is, then up to five pieces of `file:line` or command-output evidence with exact line numbers (the server reads them back), verified facts kept apart from guesses, and no unsupported likelihood rankings.

### Added

- **Cited lines come with the report.** The server reads every `file:line`, `file:start-end` or `file#Lline` citation in a report and returns the lines as `evidence`. Codex can check a report without opening files. Citations of missing files or past the end of a file are marked `ok: false`. Only files inside the worker's directory (its worktree first) are read, up to 8 citations and 6,000 characters.
- **Write results awaiting review carry their diff.** `team_wait` attaches the changed files, out-of-scope files and up to 12,000 characters of patch, so Codex can call `team_review` without `team_diff` first.
- `team_wait` reports each run's `durationMs` and `turns` and the call's own `waitedMs`. When the wait limit is under two minutes, a timed-out result carries a `hint` on how to raise it.
- **`explore` task option.** Lets a worker use Claude Code sub-agents (see above). A hook keeps read workers and their sub-agents on Read/Glob/Grep, keeps verify workers from editing files, and blocks other agent types and nesting.
- **Command tasks.** A verify task with `verify` and no `prompt` runs the command directly in the MCP server, without starting Claude Code, and reports the exit code and output tail (with `evidence` for cited lines). Use it for the final test run after several writes. `team_send` or `team_resume` runs it again.
- **`verify: "auto"`.** The server picks the test command from the project files (`package.json` test script with the matching package manager, `go.mod`, `Cargo.toml`, pytest config, Gradle, Maven, .NET, `make test`), searching up to the repository root. A write task where nothing is found falls back to Codex review with a warning.
- **A `verify` command that can't run goes straight to Codex.** "Command not found" (exit 127, or 9009 on Windows) is no longer sent back to the worker as a test failure, so it doesn't use up fix rounds.
- **Timing.** The server records Codex's time between calls, time blocked in `team_dispatch`/`team_wait`, Claude Code run time, and its own verify, merge and worktree time. `team_status` returns it as `timing` (per worker and per team), and `cc-team-mcp stats --team <id>` prints it from the terminal, even while the team is open.
- `doctor` reports Codex's `tool_timeout_sec` and `CC_TEAM_WAIT_TIMEOUT_MS` for this server under `checks.codexWait`, with a hint when `team_wait` can only block briefly.

### Removed

- **The workers' `report_progress` tool.** Codex blocks in `team_dispatch` and doesn't read progress, so each call only cost the worker another model turn. The worker's own messages are still recorded as progress events.

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
