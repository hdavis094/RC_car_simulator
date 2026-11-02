# Orchestrator runbook

For the Claude session that runs the build from T3 Code. You dispatch task briefs to workers, review what comes back, and merge it. Workers build; you write product code only in tasks assigned to Claude (Opus) or as a sub-agent you start.

## Starting a session

1. Read `AGENTS.md`, `docs/PRD.md` and `docs/ARCHITECTURE.md` once.
2. Print the status board: `grep -H '^Status:' docs/tasks/P*.md`.
3. Work the first unfinished phase. A task is **ready** when every task in its `Depends on` line is `done`.

## Roster

| Agent | Model | Tasks |
|---|---|---|
| Claude (Opus): you | — | P0-01 … P0-05, P2-01, all merges and contract changes |
| Claude worker (T3 thread) | Sonnet | P1-A, P1-H |
| Codex | gpt-6.1-sol | P1-C, P1-D, P1-G |
| Antigravity (`agy`) | default | P1-E, P1-F |
| OpenCode | freebeam | P1-B; spare for a stalled or reassigned task |

## Phases

- **Phase 0 — contracts.** Do P0-01 → P0-05 in order yourself. Then **stop for the user's review** of the contracts (`packages/schema`, `sim-protocol`, `control-protocol`, `sim-core/src/api`, `apps/desktop/src/shared`). From then on the contracts are locked.
- **Phase 1 — parallel build.** At most **4 workers at once**.
  - **Wave 1**: A, C, D, E.
  - **Wave 2**: B, F, G, H, each starting as soon as its dependencies have merged.
- **Phase 2 — integration.** P2-01 yourself. Then **stop for the user's demo review**.
- **Phase 3.** Write the briefs from `docs/tasks/P3-backlog.md` and dispatch them the same way.

## Dispatch

Tested in P0-01 on 2026-10-31. The decision is recorded in [ADR 0006](adr/0006-dispatch-workers-through-t3-mcp.md): **every worker is a T3 thread** (Path A). Path B is the fallback for when T3 Code is unavailable.

Order matters, so the brief's Status line doesn't conflict at merge time:

1. On `main`, set the brief's `Status: in-progress` and commit (`docs(tasks): dispatch <ID>`).
2. Launch the worker. The new branch `ws/<id>` starts from that commit (id is lowercase: `p1-c`).

Every agent gets the **same worker prompt**:

```
You are a worker on the Donkey Car Simulator. Your task brief is
docs/tasks/<FILE>. Read AGENTS.md, then the brief and everything under
"Read first". Write only inside the brief's owned paths. You are done when the
brief's Acceptance list holds and you have committed on branch ws/<id> and
filled in the brief's Handoff section, then set its Status to in-review.
```

### Path A: T3 MCP (default)

One `t3_thread_launch` call per worker. It creates the worktree and branch, binds the thread to them, and starts the agent. Every field except `modelSelection` is the same for all agents:

```json
{
  "title": "<ID> <brief title>",
  "modelSelection": <see table>,
  "runtimeMode": "full-access",
  "workspaceStrategy": { "type": "worktree", "baseRef": "main", "branch": "ws/<id>", "startFromOrigin": false },
  "message": "<worker prompt>"
}
```

| Agent | `modelSelection` |
|---|---|
| Codex | `{"instanceId":"codex","model":"gpt-6.1-sol","options":[{"id":"reasoningEffort","value":"high"}]}` |
| OpenCode | `{"instanceId":"opencode","model":"opencode/beam-free"}` |
| Antigravity | `{"instanceId":"antigravity","model":"gemini-4-argon-medium"}` (agy's default model) |
| Claude sub-agent | `{"instanceId":"claudeAgent","model":"claude-sonnet-5-5"}` |

Set `reasoningEffort` explicitly for Codex, because T3 defaults `gpt-6.1-sol` to `low`. `orchestrator_capabilities` lists the live model ids and options. Check it if a launch rejects a model.

- **Where it runs**: T3 puts the worktree at `~/.t3/worktrees/RC_car_simulator/ws-<id>` (the branch name with `/` replaced by `-`). `git worktree list` shows it.
- **Following a worker**: the user watches the thread in T3 Code. `t3_thread_wait` (with a timeout) or `t3_thread_read` shows progress. The worker is finished when `git show ws/<id>:docs/tasks/<FILE> | grep '^Status:'` reads `in-review` or `blocked`.
- **Sending findings back**: find the thread with `t3_thread_list` (`titleContains: "<ID>"`), then `t3_thread_send` the findings to it. The worker keeps its context and its worktree.
- **After merge**: `git worktree remove ~/.t3/worktrees/RC_car_simulator/ws-<id>` and `git branch -d ws/<id>`.
- **If a launch errors or its response is lost**: check `t3_thread_list` before you retry, because the thread may already exist.

### Path B: headless CLI (fallback)

Create the worktree yourself, then run from the repo root in the background. Every command below committed a file in a linked worktree during the spike:

```sh
git worktree add ../rc-sim-wt/<id> -b ws/<id> main

codex exec -C ../rc-sim-wt/<id> --sandbox danger-full-access -m gpt-6.1-sol --json \
  -o logs/<id>.last.txt "<prompt>" > logs/<id>.jsonl 2> logs/<id>.err

(cd ../rc-sim-wt/<id> && opencode run -m opencode/beam-free --format json --auto "<prompt>" < /dev/null) \
  > logs/<id>.jsonl 2> logs/<id>.err

(cd ../rc-sim-wt/<id> && agy -p "<prompt>" --output-format json --sandbox --dangerously-skip-permissions < /dev/null) \
  > logs/<id>.json 2> logs/<id>.err
```

- **Codex**: `--sandbox workspace-write` can't commit in a linked worktree. It keeps the main repo's `.git` read-only, even when that is passed with `--add-dir`. It also has no network unless you add `-c sandbox_workspace_write.network_access=true`. Use `danger-full-access`. Reasoning effort comes from `~/.codex/config.toml` (`high`).
- **OpenCode**: works without `--auto` with the current permission config. Keep `--auto` so a stricter config can't stall the run.
- **agy** (v1.4.12): print mode does not hang when stdout is redirected. Without `--dangerously-skip-permissions` it denies every write and still exits 0 with `"status":"SUCCESS"`. Check `denied_actions` in the output. `--sandbox` still allows network (`pnpm view` worked).
- **Claude**: no CLI command was tested. Normally a Claude worker is a Path A thread on `claude-sonnet-5-5`. If T3 Code is down, start a Sonnet sub-agent whose working directory is `../rc-sim-wt/<id>`.

## Merging

When a brief says `Status: in-review`:

1. **Rebase** `ws/<id>` onto `main`. Resolve `pnpm-lock.yaml` conflicts by running `pnpm install`.
2. **Verify**: `pnpm verify` in the worktree must pass. Once a GitHub remote exists, push `ws/<id>` and wait for CI to pass on both Linux and macOS. That run is the only check of macOS.
3. **Ownership**: `git diff --name-only main...ws/<id>` lists only the brief's owned paths, plus `docs/tasks/<its brief>`.
4. **Review by a different vendor** than the author, against the brief and `AGENTS.md`:
   - Claude-authored work: the Codex plugin's adversarial review (`/codex:adversarial-review`).
   - Codex, Antigravity and OpenCode work: a Claude sub-agent running the `code-review` skill with the brief as the spec.
   - Phase 0 contracts: both.

   Send blocking findings back to the same worker. Note non-blocking ones in the Handoff.
5. **Merge**: `git merge --no-ff ws/<id>`, set `Status: done`, remove the worktree, and start any task the merge has made ready.

## Contract change requests

Read every Handoff's **Contract change requests**. To accept one, make the smallest change on `main` yourself, run `pnpm verify`, and rebase every in-flight worktree that depends on that contract. To decline one, answer in the Handoff with the alternative. For anything that changes PRD scope, ask the user.

## When a worker fails

- A worker that sets `Status: blocked` (three failed verify runs, or a contract blocker) has its Handoff read first.
- Retry once with a sharper prompt, or reassign to OpenCode (or to a Claude sub-agent if OpenCode wrote it).
- After that, stop and ask the user.

## One-time setup the user does

- `gh auth login`, then create the GitHub repo (public for now, by the user's choice) and push, so CI runs. **Required before Phase 1:** the macOS CI job is the only way this Linux machine can verify macOS support. If it's missing at the end of Phase 0, ask the user.
- In Claude Code: `/plugin marketplace add openai/codex-plugin-cc`, then `/plugin install codex@openai-codex`, then `/codex:setup`.
- In T3 Code: grant this session's MCP connection Full access (during P0-01).
