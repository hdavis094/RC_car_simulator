# P0-01 — Spike: choose how the orchestrator dispatches workers

Status: todo
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

- [ ] ADR 0006 records the choice and why
- [ ] ORCHESTRATOR.md Dispatch section has copy-pasteable commands for each agent, all actually run once during the spike
- [ ] throwaway worktrees and branches removed

## Out of scope

Any product code.

## Handoff

- **Built**:
- **Deviations from the brief**:
- **Open questions**:
