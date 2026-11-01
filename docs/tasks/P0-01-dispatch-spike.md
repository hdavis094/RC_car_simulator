# P0-01 — Spike: choose how the orchestrator dispatches workers

Status: done
Agent: Claude (Opus), the orchestrator itself, in T3 Code
Branch: none (a findings note committed to `main`)
Depends on: —

## Goal

Decide how the orchestrator starts work on Codex, Antigravity and OpenCode: through **T3 Code's MCP server**, so each worker is a visible T3 thread, or through **headless CLIs** in worktrees. Everything else in the plan is the same either way. Time-box: one hour.

## Owned paths

`docs/ORCHESTRATOR.md` (the "Dispatch" section only), `docs/adr/0006-*.md`.

## Read first

`docs/ORCHESTRATOR.md`.

## Requirements

1. **Try T3 MCP.** In T3 Code, Settings → Environments → copy the MCP URL. Then run `claude mcp add --transport http t3 <url>` and `claude mcp login t3`, granting Full access. List the tools it exposes. Try to start a thread that:
   - runs on **Codex** with model `gpt-6.1-sol`
   - is in a **new worktree** off `main`
   - uses the prompt "create the file SPIKE.txt containing ok, commit it"

   Repeat for Antigravity and OpenCode.
2. **Check each CLI headless** in a throwaway worktree with the same prompt, and record the exact working flags. Things to confirm:
   - **`codex exec`**: `-C <dir>`, `--sandbox workspace-write`, whether `-c sandbox_workspace_write.network_access=true` is needed for `pnpm install`, `--json`, `-o <file>`
   - **`opencode run`**: run `opencode models` and record the exact id of the default **freebeam** model; check `--format json`
   - **`agy -p`**: check `--output-format json`, `--sandbox`, and the permission flags needed for edits in print mode. A known bug made print mode hang when stdout isn't a terminal; it was not seen on v1.4.11. Re-check
3. Pick: **T3 MCP** if it can choose the provider, the model and the worktree for every worker agent. Otherwise **CLI**, keeping T3 as the place to watch the orchestrator.
4. Record the decision as ADR 0006 and write the exact commands into the Dispatch section of `docs/ORCHESTRATOR.md`.

## Acceptance

- [x] ADR 0006 records the choice and why
- [x] ORCHESTRATOR.md Dispatch section has copy-pasteable commands for each agent, all actually run once during the spike
- [x] throwaway worktrees and branches removed

## Out of scope

Any product code.

## Handoff

- **Built**:
  - Decision: **T3 MCP (Path A)**. `t3_thread_launch` chose the provider, model, reasoning effort, runtime mode and a new `main`-based worktree on a named branch, all in one call. All four worker agents created and committed `SPIKE.txt` this way: Codex `gpt-6.1-sol` (default and `high` effort), OpenCode `opencode/beam-free`, Antigravity `gemini-4-argon-medium` and Claude `claude-sonnet-5-5`.
  - All three headless CLIs were also run in throwaway `../rc-sim-wt/` worktrees, with a commit and a network check (`pnpm view zod version`). The working flags are in ORCHESTRATOR.md → Dispatch → Path B.
  - Written: ADR 0006, and the Dispatch section of `docs/ORCHESTRATOR.md`.
- **Deviations from the brief**:
  - Skipped `claude mcp add` / `claude mcp login`. T3 Code already injects its `t3-code` MCP server, at full access, into this orchestrator session.
  - The Claude workers (P1-A, P1-H) were also tested as T3 threads, and the plan now dispatches them that way.
  - Codex `--sandbox workspace-write` can't commit in a linked worktree, even with `--add-dir <repo>/.git`. The fallback therefore uses `danger-full-access`.
- **Open questions**:
  - The Roster table still says "Claude sub-agent" for P1-A and P1-H. With Path A they run as T3 threads on Sonnet 5.5. That section is outside this brief's owned paths, so it was left alone.
  - T3 workers run unsandboxed (`full-access`). The guard is the ownership check at merge.
