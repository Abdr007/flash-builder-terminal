<!--
  Thanks for the contribution. Please fill this in — it makes review faster
  and reduces back-and-forth.

  For security-sensitive changes, follow the disclosure policy in SECURITY.md
  BEFORE opening a public PR.
-->

## What this changes

<!-- One paragraph max. What does this PR do, and why? Link the issue if applicable. -->

## How to verify

```bash
# Commands a reviewer can run to convince themselves the change works:
npm test
npm run typecheck
npm run lint
# (optional, only if your change touches money flow:)
npm run smoke:local
```

## Risk

- [ ] No money-flow change (UI / docs / tests / refactor only)
- [ ] Money-flow change — reviewed against [`THREAT_MODEL.md`](../THREAT_MODEL.md)
- [ ] Adds a new signed instruction — verified `security/validate-programs.ts` allowlist still covers it
- [ ] Bumps a dependency — checked for new transitive deps + license changes

## Checklist

- [ ] No keys, wallet files, or `.env` committed
- [ ] Tests added or updated
- [ ] Parser changes have a row in `test/dispatch.test.ts`
- [ ] `npm test` + `npm run typecheck` + `npm run lint` all green locally
- [ ] If user-visible: README / `magic help` / `SKILL.md` updated
- [ ] If breaking: `CHANGELOG.md` entry added under the next version
