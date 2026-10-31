# Contributing to Apple Mail MCP Server

Thank you for your interest in contributing! This document provides guidelines for contributing to the project.

## Development Setup

1. **Clone the repository**

   ```bash
   git clone https://github.com/sweetrb/apple-mail-mcp.git
   cd apple-mail-mcp
   ```

2. **Install dependencies**

   ```bash
   corepack enable && pnpm install --frozen-lockfile
   ```

   This repo pins pnpm via `packageManager` in `package.json` — `corepack enable` provides it. Development needs Node >= 22.13 (CI tests on Node 22 and 24); the published server itself runs on Node >= 20. A `preinstall` guard rejects `npm install`/`yarn` in a git checkout: they resolve dependencies off-lockfile, so the committed bundle would mismatch CI.

3. **Build the project**

   ```bash
   pnpm run build
   ```

4. **Run tests**
   ```bash
   pnpm test                        # unit tests (no Mail.app account needed)
   pnpm run test:integration         # production schema and stdio contracts
   RUN_MAIL_IT=1 pnpm run test:integration # live, read-only Mail.app checks on a configured Mac
   ```

## Code Style

This project uses ESLint and Prettier for code quality and formatting.

```bash
pnpm run lint        # check
pnpm run lint:fix    # auto-fix
pnpm run format      # format
pnpm run format:check
```

## Testing

All new features should include tests. We use Vitest.

```bash
# Run unit tests
pnpm test

# Run tests in watch mode
pnpm run test:watch

# Run cross-platform integration contracts (live suites are explicitly skipped)
pnpm run test:integration

# Run all offline suites, including release guards and the packaged plugin
pnpm run test:all

# Include real IMAP tests against the configured disposable GreenMail server
RUN_IMAP_IT=1 pnpm run test:all

# Include read-only live Mail.app tests on a configured Mac
RUN_MAIL_IT=1 pnpm run test:all
```

### Test File Locations

- **Unit tests:** `src/services/appleMailManager.test.ts` (core logic), `src/security.test.ts` (input validation and security schemas)
- **Integration contracts:** `test/integration.test.ts` (imports production schemas; live Mail.app checks require `RUN_MAIL_IT=1`), `test/output-schema.test.ts` (built server over stdio)
- **Live IMAP:** `test/imap.integration.test.ts` (`RUN_IMAP_IT=1`, disposable GreenMail server)
- **Standalone artifacts and release guards:** `test/*.test.mjs`, `.github/scripts/*.test.mjs`

### Before cutting a release

CI runs macOS unit/coverage checks on Node 22 and 24, production integration
contracts, real GreenMail IMAP integration, and standalone plugin checks on Node 20. macOS-only plist and JXA checks remain enabled on those runners. Linux skips
only the tests that require macOS APIs; a skipped test is not a verified behavior.

GitHub runners have no configured Mail.app account. End-to-end Mail operations
still require the read-only live suite on a configured Mac:

```bash
RUN_MAIL_IT=1 pnpm run test:all
```

A green CI run alone does not exercise the live Mail.app behavior.
Publishing requires successful full CI for the exact commit on main on every
trigger, including manual and scheduled recovery. The standalone plugin archive
is validated before npm publication.

### Testing Guidelines

- Tests mock the `executeAppleScript` function since AppleScript only works on macOS
- Test both success and failure paths
- Test edge cases (empty strings, special characters, etc.)
- Security-sensitive changes should include tests in `src/security.test.ts`

## Before you open a PR

Review time is the bottleneck here, so a few ground rules keep it moving:

- **One open PR at a time per contributor.** Further PRs from the same author
  wait unreviewed until the current one is merged or closed. A tight series is
  fine. Land it one PR at a time.
- **Open an issue first** for anything that changes:
  - the skill in `skills/`. It ships to every host (Claude, Codex,
    Antigravity), so a change for one host changes default behaviour for all
    of them.
  - a security boundary: allowed path roots, permission or Full Disk Access
    handling, or any check on what the server may read, write or send.

  Agree the approach in the issue before writing the code.

- **AI-assisted PRs are welcome, and you own the diff.** Green CI is not
  evidence that a change is right. Say how you verified it against real data,
  and keep each PR to one concern.

## Pull Request Process

1. Create a feature branch (`git checkout -b feature/your-feature-name`).
2. Make your changes — follow the existing style, add JSDoc, add tests.
3. Run all checks: `pnpm run lint && pnpm run typecheck && pnpm run format:check && pnpm test && pnpm run build`.
4. Make sure your PR satisfies everything in "What CI requires of your PR" below.
5. Commit with clear messages referencing any related issues.
6. Push and open a PR describing what it does and linking related issues.

## What CI requires of your PR

- **Patch bump + CHANGELOG for shipped code.** Any change to shipped bytes (`src/**` excluding tests, the runtime `dependencies` in `package.json`, or the committed `build/` bundle) must bump `package.json` at least a patch (`pnpm version patch --no-git-tag-version`) and add a CHANGELOG.md entry in the same PR — the `require-version-bump` check fails the PR otherwise. Docs-only and test-only PRs are exempt.
- **Committed, rebuilt `build/`.** The bundled `build/index.js` and `build/cli.js` are committed to git: after source changes, rebuild (`pnpm run build`) and commit the updated bundle alongside `src/` — CI verifies the committed bundle matches the source and boots it standalone on Node 20.
- **Prettier-clean.** `pnpm run format:check` must pass (CI gates formatting separately from lint).
- **Tests green.** `pnpm test` must pass on Node 22 and 24; run the integration suite locally for AppleScript-path changes (see above).

## Adding New Tools

When adding a new MCP tool:

1. **Add the schema** in `src/index.ts` (with a structured `Use when: / Returns: / Do not use when:` description, plus `Safety:` for any write/destructive tool)
2. **Implement the method** in `src/services/appleMailManager.ts`
3. **Add type definitions** in `src/types.ts`
4. **Write tests** in `src/services/appleMailManager.test.ts`
5. **Update documentation** in README.md and CHANGELOG.md. If the skill guidance changed, edit `skills/apple-mail/SKILL.md` (the canonical copy) and run `pnpm run sync:skills` — the `codex/` and `.antigravity-plugin/` copies are generated from it and CI fails if they drift

## AppleScript Guidelines

- Always escape user input using `escapeForAppleScript()`
- Handle errors gracefully (return null/false instead of throwing)
- Log errors with `console.error()` for debugging
- Test on actual macOS when possible

## Questions?

Open an issue for any questions about contributing.
