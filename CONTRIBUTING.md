# Contributing to comind-mcp

comind-mcp is an open-source project ([MIT](./LICENSE)) hosted at
**https://github.com/comind-pro/comind-mcp**. Contributions of any size are welcome —
bug fixes, new connectors/tools, docs, and tests.

## Ways to contribute

- **Report a bug** — open an [issue](https://github.com/comind-pro/comind-mcp/issues) with steps to reproduce, expected vs. actual, and your environment (Node version, OS).
- **Request a feature** — open an issue describing the use case before sending a large PR, so we can align on the approach.
- **Send a pull request** — fixes, features, docs, or tests.

## Development setup

Prerequisites: Node 20+, pnpm 9 (`corepack enable`), Docker (local Postgres).

```bash
corepack enable
pnpm install
cp .env.example .env   # fill in the required vars
make db-up             # local Postgres via docker-compose
pnpm dev               # runs server + web in parallel
```

Full details in [DEVELOPMENT.md](./DEVELOPMENT.md).

## Workflow

1. **Fork** the repo and create a branch off `main`:
   - `feat/<short-name>` for features
   - `fix/<short-name>` for bug fixes
   - `docs/<short-name>` / `chore/<short-name>` otherwise
2. Make your change. Keep PRs focused — one logical change per PR.
3. **Check before pushing:**
   ```bash
   pnpm typecheck
   pnpm -r test
   pnpm -r build
   ```
4. **Commit** using [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat(api): ...`, `fix(gateway): ...`, `docs: ...`, `test(...): ...`, `chore: ...`
   - Keep the subject ≤ ~72 chars; add a body explaining the *why* when it isn't obvious.
5. **Open a PR** against `comind-pro/comind-mcp:main` with a clear title and description. Link the related issue (`Closes #123`).

## Code style

- TypeScript across `server/` and `web/`. Match the style of the surrounding code.
- Prefer small, composable modules. No new heavy dependencies without discussion.
- Add or update tests for behavior changes (pure modules are covered with Vitest).

## Reporting security issues

Please **do not** open a public issue for security vulnerabilities. Report them privately
via the repository's security advisories on GitHub instead.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](./LICENSE) that covers the project.
