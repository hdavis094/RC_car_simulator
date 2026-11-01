# Workers are dispatched as T3 threads through T3 Code's MCP server

The orchestrator starts every worker with `t3_thread_launch` from the `t3-code` MCP server, one top-level T3 thread per task. In the P0-01 spike (2026-10-31), a single call chose the provider, the model, the model options (reasoning effort), the runtime mode and a new worktree on a named branch off `main`. It worked for all four worker agents: Codex `gpt-6.1-sol`, OpenCode `opencode/beam-free`, Antigravity `gemini-4-argon-medium` and Claude `claude-sonnet-5-5`. Each one created and committed a file on its own branch. The user can watch every worker and step into it in T3 Code, and `t3_thread_wait`, `t3_thread_read` and `t3_thread_send` let the orchestrator follow a worker and send review findings back to the same session.

## Considered options

- **Headless CLIs in self-made worktrees** (`codex exec`, `opencode run`, `agy -p`). All three work, but they need per-tool flags to edit and commit, and their output lands in log files that nobody watches. Two traps were found:
  - Codex's `workspace-write` sandbox keeps the main repo's `.git` read-only, even when it is passed with `--add-dir`, so a worker in a linked worktree cannot commit. Only `--sandbox danger-full-access` works.
  - `agy -p` without `--dangerously-skip-permissions` silently denies file writes and still exits 0 with `"status":"SUCCESS"`.

  They stay documented as the fallback for when T3 Code is down.

## Consequences

- T3 creates worktrees under `~/.t3/worktrees/RC_car_simulator/<branch with / replaced by ->`, not in `../rc-sim-wt/`.
- Workers run with `runtimeMode: "full-access"`, so they are not sandboxed. The brief's owned paths and the merge-time ownership check are the guard.
- Claude workers (P1-A, P1-H) also run as T3 threads rather than as in-process sub-agents. All workers then look the same to the user and to the orchestrator.
