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
   pnpm test                 # unit tests (fast, no Mail.app needed)
   pnpm run test:integration # live Mail.app interaction (requires a configured macOS Mail.app)
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

# Run integration tests (requires macOS with Mail.app configured)
pnpm run test:integration

# Run all tests (unit + integration)
pnpm run test:all
```

### Test File Locations

- **Unit tests:** `src/services/appleMailManager.test.ts` (core logic), `src/security.test.ts` (input validation and security schemas)
- **Integration tests:** `test/integration.test.ts` (live Mail.app interaction)

### Before cutting a release

CI runs only the **unit** tests — the integration suite needs a live, configured
Mail.app and so cannot run on the GitHub runners. The AppleScript paths (search,
list, get-message, attachments, batch ops, rename) are therefore **only**
covered by the local integration suite. Before bumping the version and pushing a
`chore(release)` commit, run the full suite locally on a configured Mac:

```bash
pnpm run test:all   # unit + integration against real Mail.app
```

A green CI run alone does not exercise the live Mail.app behavior.

### Testing Guidelines

- Tests mock the `executeAppleScript` function since AppleScript only works on macOS
- Test both success and failure paths
- Test edge cases (empty strings, special characters, etc.)
- Security-sensitive changes should include tests in `src/security.test.ts`

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
