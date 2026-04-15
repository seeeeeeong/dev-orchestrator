---
name: core-conventions
description: Conventions to follow when modifying the dev-orchestrator Node.js codebase itself.
---

# dev-orchestrator Coding Conventions

## Module System
- CommonJS (`require`/`module.exports`)

## CLI and Process Execution Rules
- Run git commands only through `runCmd`, `runSpawn`, or `gitCommit`
- Invoke Claude CLI only through `runClaude`
- Never use `shell: true` with `spawn` because of command injection risk

## Discord Rules
- Respect the 2000-character message limit by using `sendChunks`
- Trim error messages with `.slice(0, 500)` before sending them

## Security
- Never hardcode tokens or keys from `.env`
- Never pass external input such as Discord messages directly into CLI arguments
- Never use dynamic code execution such as `eval()` or `new Function()`

## Code Style
- Keep each function or method focused on a single responsibility
- Extract magic numbers or strings into constants such as `MAX_REVIEW_RETRIES`
- Before adding a new utility, first confirm whether an existing helper already solves the problem
