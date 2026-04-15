---
name: git-commit
description: Use when writing a commit message. Analyze staged changes and generate a message that follows project conventions.
---

# Git Commit Message Rules

## Format - Conventional Commits

```
type(scope): title (within 72 characters)

Body (optional: only for complex changes)
- What changed
- Why it changed, not how

Footer (optional)
Closes #issue-number
```

## Allowed Types

| type | When to use | Example |
|------|------|------|
| feat | Add a new feature | feat(auth): add JWT login API |
| fix | Fix a bug | fix(post): remove duplicate last-page pagination query |
| refactor | Improve code without behavior change | refactor(user): split service layer responsibilities |
| test | Add or update tests | test(auth): add token expiration coverage |
| docs | Documentation-only change | docs: expand API endpoint documentation |
| chore | Build, dependency, or config changes | chore: adopt multi-stage Docker build |
| perf | Performance improvement | perf(query): fix N+1 query in post list |
| style | Formatting-only change | style: apply ktlint auto-format |

## Scope Rules
- Use the domain or module that best represents the main change
- Bot project scopes: `commit`, `review`, `prompt`, `discord`, `cli`
- blog-api: auth, post, user, comment, common
- blog-web: page, component, api, hook

## Bad Examples
- `update code` - too vague
- `fix bug` - does not identify the bug
- `WIP`, `.`, `temp` - meaningless messages
- `feat: implemented JWT login API successfully` - unnecessarily verbose

## Decision Criteria
1. Inspect changes with `git diff --staged`
2. Make the title about the **single most important change**. If there are multiple concerns, consider splitting the commit.
3. The title alone should make the change understandable
4. If there is an issue number, add `Closes #number` in the footer
