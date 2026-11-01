# <ID> — <title>

Status: todo
Agent: <agent (model)>
Branch: ws/<id-lowercase>
Depends on: <task IDs that must be merged first>

## Goal

<One paragraph: what exists when this is done, and why it matters.>

## Owned paths

<Paths this task may write. Everything else is read-only.>

## Read first

<Contracts and docs this task consumes.>

## Requirements

<Numbered, concrete.>

## Acceptance

All of these, checked by the orchestrator before merge:

- [ ] `pnpm verify` passes
- [ ] <task-specific, checkable criteria>

## Out of scope

<What a reasonable worker might do but must leave alone.>

## Handoff

_Worker fills this in before finishing._

- **Built**:
- **Deviations from the brief**:
- **Contract change requests**:
- **Open questions**:
