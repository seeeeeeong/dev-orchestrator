---
name: build-test
description: Use when running builds, tests, or lint checks. Review this before validating changes.
---

# Build and Test Commands

## dev-orchestrator (Node.js)

```bash
npm install        # Install dependencies
npm run lint       # Run lint if configured
node index.js      # Start the app; a running process means startup succeeded
```

## blog-api (Kotlin/Spring Boot)

```bash
./gradlew build           # Build including tests
./gradlew test            # Run tests only
./gradlew ktlintCheck     # Run lint
./gradlew ktlintFormat    # Auto-fix lint issues
```

## blog-web (React/TypeScript)

```bash
npx tsc --noEmit                # Type-check
npm run lint                    # Run lint
npm run lint -- --fix           # Auto-fix lint issues
npm test -- --watchAll=false    # Run tests
npm run build                   # Build
```

## Validation Order

1. **Lint** -> If it fails, auto-fix when possible and rerun
2. **Type-check** -> For TypeScript projects only
3. **Test** -> If tests fail, identify the root cause and fix it
4. **Build** -> Read the full error output and fix the actual issue
5. **Commit only after everything passes**

## Failure Handling Rules

| Situation | Correct response | Never do this |
|------|------------|----------|
| Lint error | Auto-fix with `--fix` when possible, then rerun | Disable lint rules |
| Test failure | Find the cause and fix the code | Delete or skip tests |
| Type error | Correct the types | Cast to `any` as a shortcut |
| Build failure | Analyze the error logs and fix the real issue | Commit with `--no-verify` |

## When Existing Tests Break

- First confirm whether your changes caused the failure
- Verify whether the existing expected value is actually correct because the test itself may be wrong
- If behavior changed intentionally, update the tests together with the code
- **Never** change test expectations blindly without understanding the behavior
