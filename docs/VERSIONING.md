# Versioning & release policy

How we version and release **tunlite**. Keep this short and follow it every release.

## Scheme

- **Semantic Versioning 2.0.0** — `MAJOR.MINOR.PATCH`.
- Git tags are the version prefixed with `v` — e.g. `v0.2.0`.
- Versions are **monotonically increasing**: every release is strictly greater
  than the last (`v0.1.0` < `v0.1.1` < `v0.2.0` < `v1.0.0`). Never reuse or move
  a published tag.

### What bumps what

While `0.x` (pre-1.0, the API/CLI may still shift):

| Bump | When | Example |
|---|---|---|
| **PATCH** (`0.1.0 → 0.1.1`) | bug fixes only, no new commands/flags | fix a reconnect race |
| **MINOR** (`0.1.0 → 0.2.0`) | new commands/flags/behavior; may include breaking CLI changes (allowed in 0.x) | add a new command |
| **MAJOR** (`0.x → 1.0.0`) | the CLI is declared stable | first stable release |

After `1.0.0`, breaking changes require a MAJOR bump.

## Single source of truth

These three must always agree for a release:

1. `package.json` `"version"`
2. The top dated section in `CHANGELOG.md`
3. The git tag `vX.Y.Z`

## Branch model

- **`dev`** — the trunk / always-latest. Routine work (features, fixes, docs) is
  committed straight to `dev` and pushed.
- **`master`** — released versions only. `tunlite update` and the unpinned default
  install track `master`, so it must always equal the latest real release.
- A **release** is the only thing that updates `master`: merge `dev → master`
  (pull request or fast-forward), then tag that commit.

## Release checklist

Everything below runs from `dev`.

1. `node --test` — all green (CI runs the same matrix on every push/PR).
2. Decide the bump (PATCH / MINOR / MAJOR) from changes since the last tag:
   `git log --oneline vLAST..origin/dev`.
3. On `dev`, set the version in `package.json`.
4. Move `CHANGELOG.md` "Unreleased" items into a new `## [X.Y.Z] - YYYY-MM-DD`
   section (Added / Changed / Fixed) and update the compare links at the bottom.
5. Commit on `dev`: `chore(release): vX.Y.Z`, then `git push origin dev`.
6. Merge `dev` into `master` (PR or fast-forward) and push `master`.
7. Tag the release commit on `master` and push the tag:
   - `git checkout master && git pull`
   - `git tag -a vX.Y.Z -m "tunlite vX.Y.Z" -m "<highlights>"`
   - `git push origin vX.Y.Z`
   - `git checkout dev`
8. Create the **GitHub Release** for `vX.Y.Z` (paste the CHANGELOG section).
9. Publish to npm: `npm publish --dry-run` to check the tarball, then `npm publish`.
   Users can also install via `npx "github:yuanyuanzijin/tunlite#vX.Y.Z" install`,
   the `curl … bootstrap.sh | sh` one-liner, or `tunlite update`.

## Release notes

Every release MUST have a `CHANGELOG.md` entry **and** a matching annotated tag
message and GitHub Release. Write notes for users (what changed and why it
matters), grouped as Added / Changed / Fixed, in reverse-chronological order.

## Notes

- `master` only ever moves by merging a release from `dev`; never commit straight
  to `master`.
- `npm version <patch|minor|major>` can bump `package.json` and tag in one go, but
  on this repo author the CHANGELOG by hand and create the tag on `master` only
  **after** the release is merged — not on `dev`.
- Pre-release tags use a suffix: `v0.3.0-rc.1` (sorts before `v0.3.0`).
