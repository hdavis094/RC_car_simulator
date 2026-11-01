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
| Claude sub-agent | Sonnet | P1-A, P1-H |
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

> **Finalised by P0-01.** Until it is done, this section is the plan, not tested commands.

Every worker gets its own worktree and branch from `main`:

```sh
git worktree add ../rc-sim-wt/<id> -b ws/<id> main     # id: p1-c, etc.
```

Set the brief's `Status: in-progress` on `main` when dispatching.

Every agent gets the **same worker prompt**:

```
You are a worker on the Donkey Car Simulator. Your task brief is
docs/tasks/<FILE>. Read AGENTS.md, then the brief and everything under
"Read first". Write only inside the brief's owned paths. You are done when the
brief's Acceptance list holds and you have committed on branch ws/<id> and
filled in the brief's Handoff section, then set its Status to in-review.
```

**Path A: T3 MCP**, if P0-01 shows it can choose the provider, the model and the worktree. Start one T3 thread per worker with that prompt. The user can watch and step into every thread.

**Path B: headless CLI**, run in the background from the worktree, logging to `logs/<id>.jsonl`:

```sh
codex exec -C ../rc-sim-wt/<id> --sandbox workspace-write -m gpt-6.1-sol --json "<prompt>"   > logs/<id>.jsonl
opencode run -m <freebeam-model-id> --format json "<prompt>"                                 > logs/<id>.jsonl   # cwd = worktree
agy -p "<prompt>" --output-format json --sandbox                                             > logs/<id>.jsonl   # cwd = worktree
```

Claude workers are sub-agents started in their worktree.

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

- `gh auth login`, then create the private GitHub repo and push, so CI runs. **Required before Phase 1:** the macOS CI job is the only way this Linux machine can verify macOS support. If it's missing at the end of Phase 0, ask the user.
- In Claude Code: `/plugin marketplace add openai/codex-plugin-cc`, then `/plugin install codex@openai-codex`, then `/codex:setup`.
- In T3 Code: grant this session's MCP connection Full access (during P0-01).
