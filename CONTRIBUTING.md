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
   pnpm install
   ```

   This repo pins pnpm via `packageManager` in `package.json` — `corepack enable` provides it. Development needs Node >= 22.13 (CI tests on Node 22 and 24); the published server itself runs on Node >= 20.

3. **Build the project**
   ```bash
   pnpm run build
   ```

4. **Run tests**
   ```bash
   pnpm test
   ```

## Code Style

This project uses ESLint and Prettier for code quality and formatting.

```bash
# Check for linting issues
pnpm run lint

# Auto-fix linting issues
pnpm run lint:fix

# Format code
pnpm run format

# Check formatting
pnpm run format:check
```

## Testing

All new features should include tests. We use Vitest for testing.

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

1. **Create a feature branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes**
   - Follow the existing code style
   - Add JSDoc comments for new functions
   - Add tests for new functionality

3. **Run all checks**
   ```bash
   pnpm run lint
   pnpm run typecheck
   pnpm run format:check
   pnpm test
   pnpm run build
   ```

4. **Version bump & committed bundle** (shipped-code changes only)
   - Any change to shipped code (`src/**` excluding tests, or the runtime `dependencies` in `package.json`) must bump `package.json` at least a patch (`pnpm version patch --no-git-tag-version`) and add a CHANGELOG.md entry in the same PR — the `require-version-bump` CI check fails the PR otherwise. Docs-only and test-only PRs are exempt.
   - The bundled `build/index.js` and `build/cli.js` are committed to git: after source changes, rebuild (`pnpm run build`) and commit the updated bundle alongside `src/` — CI verifies the committed bundle matches the source.

5. **Commit your changes**
   - Use clear, descriptive commit messages
   - Reference any related issues

6. **Push and create a PR**
   - Describe what your PR does
   - Link any related issues

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
