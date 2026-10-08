# Changesets

Every PR that changes a published package adds a changeset:

```bash
pnpm changeset
```

Pick the packages, the bump (`patch` / `minor` / `major`) and write one line for the changelog.
On `main`, the release workflow keeps a "Release packages" PR open with the version bumps and
changelogs; merging it publishes to npm through trusted publishing (no tokens).
