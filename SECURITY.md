# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's [private vulnerability reporting](https://github.com/lboverfys/mcp-cccx-together/security/advisories/new) instead. Include the version, your OS, what an attacker could achieve, and steps to reproduce. Never include API keys or the contents of your state directory.

You should get a first response within 7 days. Fixes are released as a new version and noted in [CHANGELOG.md](CHANGELOG.md).

## Supported versions

Only the latest release receives security fixes.

## Threat model

CC Team MCP runs AI coding agents on your machine with your user's rights. Please read this before reporting.

- **By design, workers are not sandboxed.** In the default `bypassPermissions` mode, a worker can run any command your user can. Worktree isolation and scope checks keep cooperating workers from overwriting each other and stop file-editing tools from writing outside `scope`. They are not a security boundary against a malicious model or malicious project content: shell commands can still reach the whole filesystem. Use a container or VM for untrusted code.
- **`verify` commands run in a shell** with your user's rights. They come from the MCP client (Codex), which you already trust to run commands.
- **Prompt injection.** Project files, dependency handoffs and worker reports are treated as data, not as new user authorisation, but models can still be misled. Review results, especially from tasks that read untrusted content.
- **State files** contain task text, tool inputs and results in plain text. They are written with owner-only permissions where the OS supports it. Provider secrets referenced through `envFrom` are not written to state.

In scope for reports, for example:

- A path that lets a worker's file-editing tool write outside its `scope` despite the scope check.
- A merge that writes out-of-scope or unaccepted changes into the main working tree.
- Credentials leaking into state files, events, notifications or logs.
- Problems in lock or state handling that let one team corrupt another.
