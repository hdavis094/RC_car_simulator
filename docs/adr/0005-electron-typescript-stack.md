# Electron + TypeScript + Three.js + Rapier

Two of the three environments (Workbench, Terminal) are mostly UI: forms, tables, a code editor, terminals. The web stack is strongest there (Monaco, xterm.js, node-pty), and the AI agents building the app are most fluent in TypeScript and can verify their work headlessly with Vitest and Playwright. Physics uses Rapier's deterministic WASM build, which includes a raycast vehicle controller.

## Considered options

- **Godot 4**: better 3D tooling and native vehicle physics, but an embedded editor and terminal are awkward, and agents can't easily verify scenes.
- **Unity**: the same problems, plus licensing and a heavy Linux setup.
- **Python (Panda3D/PyBullet + Qt)**: fine physics, weak UI.
