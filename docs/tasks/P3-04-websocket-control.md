# P3-04 — WebSocket phone control

Status: in-review
Agent: Codex
Branch: ws/p3-04
Depends on: P2-01 integration (merged)

## Goal

Drive the simulated or real car from a phone browser using the desktop's existing controller connection.

## Owned paths

`apps/desktop/src/main/services/phone-control/`, `apps/desktop/src/main/{index,ipc}.ts` for registration, `apps/desktop/src/renderer/world/{PhoneControl,NetworkConsole,phone-controller}*`, `apps/desktop/package.json`, `pnpm-lock.yaml` and `docs/PHONE-CONTROL.md`. The orchestrator owns the shared IPC addition. The worker also updates this brief's Handoff.

## Read first

Read `packages/control-protocol/SPEC.md`, the desktop `ControlService`, and the PRD Wi-Fi and manual control sections.

## Requirements

1. Add an explicitly enabled LAN HTTP/WebSocket endpoint and a small touch-friendly controller page. Share an expiring session URL with an unguessable token and require the token at connection time. Keep the endpoint off until enabled and close it on lifecycle disposal.
2. Carry one control-protocol JSON message per WebSocket message and forward through the same desktop control connection to avoid replacing the firmware's current TCP peer. Serve telemetry, manual mode, drive and e-stop. Release held drive on disconnect, hidden page or a heartbeat timeout.
3. Show the phone URL and enable/disable actions in the desktop Network Console. Document how to use it with a sim run or a real TCP target on a trusted LAN.

## Acceptance

- [x] `pnpm verify` passes.
- [x] Tests cover credential rejection, valid command/telemetry routing, one active phone connection, drive release on staleness/disconnect, and server teardown.
- [x] The controller can drive the simulated starter firmware through a browser WebSocket.

## Out of scope

Direct WebSocket firmware, public Internet hosting and changing the existing TCP wire format.

## Handoff

- **Built**: The Network Console can open a 15-minute phone session and can select either the simulated car or a real TCP target. A browser on the local network uses per-message WebSocket framing. Commands and telemetry share the desktop ControlClient. The service requires its invitation token and same-origin upgrade, admits one browser, and stops held drive after 250 ms without fresh input.
  - `pnpm verify` passed on Linux. WebSocket service tests cover authorization, telemetry, sequence handling, neutral on stale input/disconnect, e-stop and expiry. An Electron browser at phone dimensions moved the simulated starter firmware car, released throttle and confirmed e-stop before disconnecting.
- **Deviations from the brief**: No scope deviations. The browser uses the desktop gateway on a trusted LAN.
- **Contract change requests**: None beyond the orchestrator-provided PhoneControlApi.
- **Open questions**: Physical phone and real-car verification remain hardware checks.
