# Contributing

Thanks for taking a look. Issues and pull requests are welcome; for anything larger than a fix,
open an issue first so we can agree on the shape.

## Setup

Node 22+ and pnpm (the version is pinned in `package.json`, `corepack enable` picks it up).

```bash
pnpm install
pnpm build        # packages first: the Lab imports their dist/
pnpm test         # vitest in every workspace
pnpm typecheck
pnpm lint
pnpm --filter lab exec playwright install chromium   # once
pnpm --filter lab test:e2e
```

## Layout

- `packages/hl-exec`: the executor. `src/executor.ts` does venue I/O only; pricing, fills,
  markets and constants are pure modules with their own tests. Tests never touch the network:
  `test/helpers.ts` builds fake `info` / `exchange` clients.
- `packages/trend-ensemble`: strategy math, backtester and paper runner. `test/parity.test.ts`
  pins the backtester to the Python engine in `research/`; if you change the math, change both.
- `apps/lab`: the Next.js site. Logic that can be pure lives in `lib/` and is unit-tested; the
  components stay thin.

## Pull requests

- Keep them focused, with tests for behaviour changes. CI runs build, typecheck, lint, unit tests
  and the Playwright suite (including an axe accessibility scan).
- If you change a published package, add a changeset:

  ```bash
  pnpm changeset
  ```

  Pick the package, the bump and one line for the changelog. While the packages are `0.x`,
  breaking changes are a `minor` bump.

## Releases

Nobody publishes from a laptop. On `main`, `.github/workflows/release.yml` keeps a
"Release packages" PR open with the pending version bumps and changelogs. Merging it runs
`scripts/release.mjs`, which publishes every package whose version is not on npm yet, tags it and
creates a GitHub release. npm authenticates the workflow through OIDC trusted publishing, so there
is no npm token in the repository or its secrets.
