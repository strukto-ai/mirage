# Contributing to Mirage

Thank you for your interest in contributing to Mirage. Mirage is a unified
virtual filesystem for AI agents, with Python and TypeScript implementations in
one repository.

## Contribution Guidelines

We prefer small, well-tested contributions that solve real user problems.

- Open an issue or discussion before starting non-trivial features, API changes,
  or large refactors.
- Link related issues or discussions in your pull request.
- Keep pull requests focused. Split unrelated changes into separate PRs.
- Include tests for bug fixes and new behavior when practical.
- Update affected docs and examples when behavior changes.
- AI-assisted contributions are fine, but they must be reviewed, edited, and
  tested by a human before submission. Bulk low-signal generated submissions
  may be closed.

## Repository Layout

- `python/` contains the Python package, tests, `pyproject.toml`, and `uv.lock`.
- `typescript/` contains the TypeScript monorepo and packages.
- `rust/` contains `mirage-rs`, the command streams both of them run, with its
  Python and WebAssembly bindings.
- `docs/`, `examples/`, and `.github/` are shared across both implementations.

Run Python commands from `python/`. Run TypeScript commands from `typescript/`.

## Development Setup

Both installs below compile `rust/`, so install
[rustup](https://rustup.rs) first; `rust/rust-toolchain.toml` then fetches the
pinned toolchain and its wasm target on first use.

Install Python dependencies:

```bash
cd python
uv sync --all-extras
```

Install TypeScript dependencies:

```bash
cd typescript
pnpm install
```

Examples under `examples/python/` load `.env.development` from the repository
root. Run them from the root with the Python virtualenv interpreter:

```bash
./python/.venv/bin/python examples/python/vfs/s3/s3.py
```

## Common Commands

Run Python tests:

```bash
cd python
uv run pytest
```

That runs one process. For a faster inner loop, spread a subset across every
core the way CI does:

```bash
cd python
uv run pytest tests/commands -n auto --dist loadscope
```

The redis tests are the exception: they share one server, so CI runs them
serially after the parallel batch rather than under `-n` (see
`.github/workflows/test_python.yml`). Leave them out of an `-n auto` run.

Coverage is not on by default, because nothing reads it. Ask for it when you
want it:

```bash
cd python
uv run pytest --cov=mirage --cov-report=term-missing
```

Run Python formatting and linting from the repository root:

```bash
./python/.venv/bin/pre-commit run --all-files
```

Run TypeScript checks:

```bash
cd typescript
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
```

Build TypeScript packages:

```bash
cd typescript
pnpm build
```

If you change Python dependencies, use `uv add` and commit the updated lock
file. If you change TypeScript dependencies, use `pnpm` and commit the updated
lock file.

## Code Style

- Represent filesystem paths with `PathSpec`, not raw strings, in Python APIs.
- Keep imports at the top of files.
- Avoid circular imports. Fix the dependency direction instead of using lazy
  function-local imports.
- Do not silently swallow exceptions. Let unexpected errors propagate, or log
  clearly when an error is intentionally ignored.
- Do not call `asyncio.run()` from sync code that may run inside an existing
  event loop.
- Keep comments and docstrings useful and concise. When adding docstring
  `Args`, include argument types.

## Pull Request Checklist

Before opening a PR:

- The change is scoped to one bug, feature, or documentation improvement.
- Related issues or discussions are linked.
- Tests were added or updated when relevant.
- Affected docs and examples were updated.
- Formatting, linting, and tests pass locally, or the PR explains why a check
  could not be run.

Useful PR title prefixes:

- `feat:` for new features
- `fix:` for bug fixes
- `docs:` for documentation changes
- `refactor:` for code restructuring
- `test:` for test-only changes
- `chore:` for maintenance work

## Releasing

A release publishes `mirage-ai` to PyPI and the `@struktoai/mirage-*`
packages to npm, all at one version, from `.github/workflows/release.yml`.
Both carry the Rust in `rust/`: each `mirage-ai` wheel its native module
(`mirage._rs`), `@struktoai/mirage-core` its WebAssembly build.

1. Set the new version in `python/pyproject.toml`, `rust/Cargo.toml` and
   each published `typescript/packages/*/package.json`, then refresh the
   locks (`uv lock` in `python/`, `cargo update --workspace` in `rust/`).
   `python3 scripts/check_release_versions.py` says whether they agree.
1. Run the Release workflow by hand to build and check everything without
   publishing: the `mirage-ai` wheels for Linux (glibc and musl), macOS and
   Windows on x86_64 and arm64, each installed with its dependencies and
   run on its own platform, the sdist, built and run the same way, and the
   npm tarballs.
1. Push a tag named for the npm spelling of the version (`v0.0.7`,
   `v0.0.7-alpha.3`) on that commit. The workflow checks the tag against
   the versions, builds again, then publishes `mirage-ai` and the npm
   packages in that order. A pre-release goes out under npm's `alpha`,
   `beta` or `rc` dist-tag, a release under `latest`.

Publishing uses trusted publishing, so no token is stored: PyPI needs a
trusted publisher for `mirage-ai` naming this repository,
`release.yml` and the `pypi` environment, and npm one per package naming
`release.yml` and the `npm` environment. To make a publish wait for
approval, add required reviewers to those two environments and limit them to
`v*` tags.

## Getting Help

Use GitHub issues for bugs, feature requests, and design discussions. For faster
conversation, join the Mirage Discord linked from the README.
