# P3-04 — WebSocket phone control

Status: in-progress
Agent: Codex
Branch: ws/p3-04
Depends on: P2-01 integration (merged)

## Goal

Drive the simulated or real car from a phone browser using the desktop's existing controller connection.

## Owned paths

`apps/desktop/src/main/services/phone-control/`, `apps/desktop/src/main/{index,ipc}.ts` for registration, `apps/desktop/src/renderer/world/{PhoneControl,NetworkConsole}*`, `apps/desktop/package.json`, `pnpm-lock.yaml` and `docs/PHONE-CONTROL.md`. The orchestrator owns the shared IPC addition. The worker also updates this brief's Handoff.

## Read first

Read `packages/control-protocol/SPEC.md`, the desktop `ControlService`, and the PRD Wi-Fi and manual control sections.

## Requirements

1. Add an explicitly enabled LAN HTTP/WebSocket endpoint and a small touch-friendly controller page. Share an expiring session URL with an unguessable token and require the token at connection time. Keep the endpoint off until enabled and close it on lifecycle disposal.
2. Carry one control-protocol JSON message per WebSocket message and forward through the same desktop control connection to avoid replacing the firmware's current TCP peer. Serve telemetry, manual mode, drive and e-stop. Release held drive on disconnect, hidden page or a heartbeat timeout.
3. Show the phone URL and enable/disable actions in the desktop Network Console. Document how to use it with a sim run or a real TCP target on a trusted LAN.

## Acceptance

- [ ] `pnpm verify` passes.
- [ ] Tests cover credential rejection, valid command/telemetry routing, one active phone connection, drive release on staleness/disconnect, and server teardown.
- [ ] The controller can drive the simulated starter firmware through a browser WebSocket.

## Out of scope

Direct WebSocket firmware, public Internet hosting and changing the existing TCP wire format.

## Handoff

- **Built**:
- **Deviations from the brief**:
- **Contract change requests**:
- **Open questions**:
