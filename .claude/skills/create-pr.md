---
name: create-pr
description: Use when creating a pull request. Write the PR title and body in the project-standard format.
---

# Pull Request Rules

## PR Title Format

```
type(scope): change summary (#issue-number)
```

Good examples:
- `feat(auth): add JWT login API (#42)`
- `fix(post): remove duplicate last-page pagination query (#67)`
- `refactor(user): split service layer responsibilities`

Bad examples:
- `add feature` - missing type
- `feat: various updates` - not specific
- `feat(auth): implemented JWT login API successfully` - too wordy

## PR Body Template

```markdown
## Summary
[Explain what changed and why in 2-3 sentences.]

## Changes
- [Describe functional changes, not filenames]
- [Example: "Added JWT token issuance and verification during login"]
- [Example: "Implemented a refresh endpoint for expired tokens"]

## Related Issue
Closes #issue-number

## How to Test
- [ ] [Only include executable test scenarios]
- [ ] [Example: "Call POST /auth/login and verify the returned token"]

## Review Points
[Anything reviewers should inspect closely, including key design decisions]
[Example: "Token expiration is set to 30 minutes because ..."]
```

## Writing Principles
- Write `Summary` in direct, concrete language
- Describe `Changes` by behavior or functionality, not by listing filenames
- `How to Test` must contain real executable scenarios, not empty checklists
- Always include `Review Points` because they save reviewer time
- Do not mix unrelated changes into a single PR
