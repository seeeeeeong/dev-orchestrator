# Dev Orchestrator Agent Guide

## Overview
Development automation bot that runs through Discord by combining Claude Code CLI with GPT-5.4 review, then carrying work through coding, review, and PR or issue creation.

## Tech Stack
- Node.js (CommonJS)
- Discord.js 14
- Claude Code CLI (`claude -p`)
- OpenAI SDK (GPT-5.4 review)
- gh CLI (GitHub PRs and issues)

## Project Map
- `index.js` - Main bot entrypoint and core logic
- `repos/` - Cloned repositories (gitignored)
- `.env` - Tokens and API keys

## Hard Rules
- Never hardcode tokens or API keys from `.env`
- Never use `shell: true` with `spawn` to avoid command injection
- Respect the 2000-character Discord message limit by using `sendChunks`
- Run git commands only through `runCmd`, `runSpawn`, or `gitCommit`
- Invoke Claude CLI only through `runClaude`

## Core Flow
1. Receive a Discord command through `parseCommand` or `parseNaturalLanguage`
2. Prepare the target repository with `ensureRepo`
3. Build a structured prompt with `buildWorkPrompt`
4. Execute the coding task through `runClaude`
5. Generate a commit message with `generateCommitMsg`
6. Run `reviewCode` with GPT-5.4, up to 5 review loops
7. Apply automatic fixes with `autoFix` when review fails
8. Build the PR body with `buildPRBody` and create the PR
9. Generate an issue body with `generateIssueBody`

## Skill References
- Commit: `.claude/skills/git-commit.md`
- PR: `.claude/skills/create-pr.md`
- Build and test: `.claude/skills/build-test.md`
- Conventions: `.claude/skills/core-conventions.md`

## Notes
- The `working` flag prevents concurrent jobs, so only one task can run at a time
- Be careful when changing prompt builder functions because output format changes can break downstream parsing
- Claude CLI automatically loads the `CLAUDE.md` file from the current working directory
