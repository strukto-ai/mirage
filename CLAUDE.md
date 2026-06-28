# CLAUDE.md

MIRAGE is a package that allows you to mount anything as a filesystem and make it usable by AI Agents.

## Repo Layout

This monorepo hosts two sibling implementations:

- `python/` — the Python package (`mirage/`, `tests/`, `pyproject.toml`, `uv.lock`).
- `typescript/` — the TypeScript monorepo (`packages/core`, `packages/browser`, `packages/node`, etc.).
- `docs/`, `examples/`, `.github/` — shared across both.

Run Python commands from `python/`, TypeScript commands from `typescript/`.

### TypeScript packages

- `typescript/packages/core` contains runtime-agnostic primitives and shared logic. Code in `core` must work in both browser and Node.js runtimes; do not put browser-only or Node-only APIs there.
- `typescript/packages/browser` contains browser-only resources, commands, and workspace wiring. It depends on `@struktoai/mirage-core`.
- `typescript/packages/node` contains Node.js-only resources, commands, and workspace wiring. It depends on `@struktoai/mirage-core`.
- Put shared TypeScript behavior in `core` only when it works in both runtime packages. Put runtime-specific behavior in `browser` or `node`.

## Python/TypeScript Parity

- Keep Python and TypeScript layout, architecture, and semantics mirrored as much as practical.
- When changing one implementation, check the other for the matching pattern or feature. If one side is more correct, use it to improve the weaker side instead of copying a bad design.
- For major Python or TypeScript changes, consider adding or updating integration coverage under `integ/`.
- Known gap: TypeScript does not support ORC files. Python registers `.orc` in its filetype factory (`mirage/core/filetype/orc.py` plus per-backend `read_orc` ops); the TypeScript filetype factory only covers parquet, feather/arrow/ipc, and hdf5/h5. Do not assume `.orc` commands work in TypeScript.

## History

Command history is a recording, not a command log. A hidden `Observer` records every top-level command as timestamp-ordered events (`COMMAND`, `CLEAR`, `DELETE`, op events); the user-facing surfaces are just views of those events.

- **Observer + ObserverStore.** The `Observer` owns a storage-agnostic `ObserverStore` (`append`/`write`/`readAll`/`readMatching`/`clear`/`close`), not a mount. Stores: `RAMObserverStore` (core, default), `DiskObserverStore` and `RedisObserverStore` (node). RAM is just the default, history can persist to disk or Redis.
- **Two views over the same events.** `/.bash_history` is a read-only view mount (`HistoryViewResource`) rendered in GNU bash histfile format (`#<epoch>` line then the command), so `cat`/`grep`/`tail`/`find` work on it for free. The `history` shell builtin (GNU `-c -d -a -n -r -w -s -p` + count) routes through the same mount, so file and builtin never disagree.
- **Recording scope.** Top-level lines record; nested evals (`$()`, `eval`, `source`, `xargs`) run with `record: false`, so their inner ops bubble to the parent and no spurious command is logged (mirrors GNU's line reader).
- **Snapshots.** History is captured as events into snapshot state and restored on load.
- **Format is GNU bash, not zsh** (`#<epoch>`, not `: <ts>:<dur>;<cmd>`).

## Development Setup

This project uses `uv` for Python dependency management. Install dependencies with:

```bash
cd python && uv sync --all-extras --no-extra camel
```

`camel` is declared as conflicting with `openai` (and other extras) in `pyproject.toml`, so `uv sync --all-extras` fails. Exclude `camel` to keep the `openai` stack.

### Running examples

Examples under `examples/python/` load `.env.development` from the repo root (cwd-relative). To keep cwd at the root while using the `python/` venv, invoke the venv interpreter directly:

```bash
./python/.venv/bin/python examples/python/s3/s3.py
```

Avoid `uv --directory python run ...` for examples — it changes cwd to `python/` and breaks `load_dotenv(".env.development")`.

## Backward Compatibility

- No need to consider backward compatibility for the code.

## Create a PR

When asked to create a PR, please follow the following steps:

1. Run `pre-commit run --all-files` from the repo root to lint and format the code.
1. Run `cd python && uv run pytest` to run the Python tests.
1. Run `git add -A` to add all changes.
1. Run `git checkout -b <branch-name>` to create a new branch.
1. Run `git commit -m "<commit-message>"` to commit the changes.
1. Run `git push origin <branch-name>` to push the changes to the remote repository.
1. Run `gh pr create --title "<pr-title>" --body "<pr-body>"` to create a PR.

## Commands

### Linting and Formatting

After making major changes, run pre-commit from the repo root to ensure code quality:

```bash
./python/.venv/bin/pre-commit run --all-files
```

Invoke the venv's `pre-commit` binary directly (not via `uv --directory python run`) so cwd stays at the repo root — otherwise `git ls-files` only lists files under `python/` and `examples/` gets silently skipped.

## Type Conventions

- Paths must always be represented as `PathSpec`, never raw strings. All functions that accept or return paths use `list[str | PathSpec]` where `str` is for text arguments and `PathSpec` is for paths. Never pass a path as a plain `str` — wrap it in `PathSpec`.

## Rules

- **Shell-style commands** (cat, grep, du, find, head, tail, wc, ls, etc.) follow POSIX / Unix coreutils semantics as much as possible; match BSD/GNU behavior and document any deliberate divergence.
- **Async-native by default.** I/O uses `aiofiles` / `redis.asyncio` / `aioboto3`, and command pipelines are async generators.
- **Python unit tests mirror src 1:1 where reasonable.** Try to have a matching `tests/<path>/test_a.py` for each source file `mirage/<path>/a.py`. `__init__.py`, pure type-stub modules, and trivial re-exports are fine to skip; modules with real logic should have one.
- **Do not add `__init__.py` files under `tests/`.** Tests are namespace packages and pytest discovers them without `__init__.py`. Don't create one when adding a new test directory.
- **Monkeypatching a backend command module in tests:** the command imports its helpers by value (`from mirage.core.<backend>.read import read_bytes`), so to intercept them you must rebind the name inside the command module, not the core source module. But the command module is hard to reach: the backend package re-exports the command function in `__init__.py` (`from .cat import cat`), which shadows the submodule of the same name, so `import mirage.commands.builtin.<backend>.cat as mod`, `from ...<backend> import cat as mod`, and even pytest's string target `monkeypatch.setattr("mirage.commands.builtin.<backend>.cat.read_bytes", fake)` all resolve to the function, not the module (`AttributeError`). The command is also wrapped by `@command`, so `cat.__globals__` is the decorator's module. Reach the real command-module namespace through the unwrapped function and patch the dict: `monkeypatch.setitem(cat.__wrapped__.__globals__, "read_bytes", fake)`.
- Avoid add any comments or docstrings on the top of the file.
- Do not create nested functions.
- Add type to Args for docstring.
- Do not add comment after each line of code in the format of "# 10MB - trigger segmentation for files larger than this". The most you can add is "# 10MB".
- For all imports you need to put to the top of the file. Don't have imports within each function.
- **No circular imports.** If putting an import at the top would cause a cycle, that's a sign the dependency direction is wrong — fix the design (dependency injection, splitting modules, moving the shared piece to a leaf), don't paper over it with function-local lazy imports. Verify by checking that running `cd python && uv run python -c "import <every changed module>"` succeeds without ImportError.
- **Never silently swallow exceptions.** `try: ... except: pass` (or `except SomeError: pass`) hides real bugs. If you genuinely need to ignore an error, log it (`logger.debug(...)`) or document loudly why it's safe. Default behavior should be: let the exception propagate. Especially never silently swallow `RuntimeError` — it usually signals something deeper (event loop in wrong state, recursion limit, etc.) that you need to actually fix.
- **Never call `asyncio.run()` inside a sync function that might be invoked under an outer event loop.** It will raise `RuntimeError: asyncio.run() cannot be called from a running event loop`. If you need async behavior from a sync API, either: (a) make the calling function `async`, (b) operate on the underlying sync state directly (e.g. write to a dict instead of calling an async setter), or (c) use a sync alternative of the same library (e.g. `redis.Redis` instead of `redis.asyncio.Redis`). Do NOT wrap with `try/except RuntimeError: pass` — that masks the bug AND leaks the unawaited coroutine.
- Please don't change any file name unless I ask you to do so.
- Don't add too many printings or comments in the code.
- Don't add README.md unless I ask you to do so.
- Use uv add to install new dependencies.
- **Command wrappers and flags.** The dispatcher passes parsed command-line flags as keyword arguments. Wrappers must declare dispatcher-injected parameters (`stdin`, `index`, `prefix`) explicitly in their signature — never fish them out of `**flags` with `.get()`. Treat `**flags: object` as an opaque bag of true command-line flags and forward it wholesale to the generic command. When a wrapper genuinely needs a flag value itself (e.g. a search push-down), read it through `FlagView` (`fl = FlagView(flags)` then `fl.bool("F")`, `fl.int("m")`, `fl.str("type")`, `fl.list("e")`) or a shared domain accessor like `pattern_arg` — never raw `flags.get(...)` / isinstance chains.
- **Generic commands own flag interpretation.** Backend wrappers are wiring only (glob resolution, backend I/O injection, pass-through of `texts` and `flags`); all flag semantics live in the generic command for that family, mirroring the TS generics. Adding or changing a flag should touch the spec and the generic, not N wrappers.
- **Generics parse flags once into a frozen struct.** Each generic defines a `@dataclass(frozen=True, slots=True)` flag struct plus a module-level `parse_flags(fl, ...)` (mirroring the TS `parseFlags` struct); the function body reads only struct attributes, never string keys. Construct the FlagView with the command's spec (`FlagView(flags, spec=SPECS["grep"])`) so a typo in a flag name raises KeyError instead of silently reading as False/None.
- **Never annotate a parameter as `object`.** Use the real type: a backend handle is `accessor: Accessor` (`mirage.accessor.base`), an index is `index: IndexCacheStore | None` (`mirage.cache.index`). Ignored variadics are still typed (`*texts: str`). `object` is only acceptable as the value type of an opaque flag bag (`**flags: object`).
