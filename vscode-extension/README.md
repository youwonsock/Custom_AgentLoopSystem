# Agent Loop Orchestrator

VS Code extension that controls the Custom Agent Loop System CLI to autonomously achieve coding goals via a multi-model, multi-session orchestrator.

## Features

- Multi-session autonomous coding loop control
- Per-agent model selection (planner, implementer, tester, qa_lead, master, interrupter)
- Live state polling and webview dashboard
- Dynamic CLI model discovery
- Session resume after pause/interrupt

## Requirements

- Node.js >= 18
- The `loop_orchestrator.js` (compiled from the parent project) accessible via `agentLoop.orchestratorScript` or placed under `<rootDir>/dist/`.
- A coding CLI binary (default: `opencode`) installed and on PATH.

## Extension Settings

- `agentLoop.cliBinary`: CLI binary name (default `opencode`)
- `agentLoop.rootDir`: Orchestrator root directory
- `agentLoop.nodeBinary`: Node.js binary path
- `agentLoop.orchestratorScript`: Path to `loop_orchestrator.js`
- `agentLoop.testCommand`: Default test command (default `npm test`)
- `agentLoop.maxIterations`: Max loop iterations (default 20)
- `agentLoop.phaseTimeoutMs`: Phase timeout (default 600000)
- `agentLoop.idleTimeoutMs`: Idle timeout (default 90000)
- `agentLoop.portsToClean`: Ports to clean before tests
- `agentLoop.pollIntervalMs`: State polling interval (default 1000)

## Commands

- `Agent Loop: Show Panel`
- `Agent Loop: New Session`
- `Agent Loop: Resume Session`
- `Agent Loop: Discover Models`
- `Agent Loop: Stop Session`
- `Agent Loop: Refresh`
