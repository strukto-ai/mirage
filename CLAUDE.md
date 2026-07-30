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
- **mirage ships no filetype renderers, and no factory for them.** Parquet, ORC, feather/arrow/ipc and hdf5/h5 rendering are gone, along with the `parquet`/`hdf5`/`pdf` extras, the `hyparquet`/`apache-arrow`/`h5wasm` dependencies, and the whole `commands/builtin/filetype_factory/` package in both languages (with its `filetype_read` / `filetypeRead` op knobs). A file with an unregistered extension is read as raw bytes. The one surviving extension point is registration on a mount: a command or op carrying a `filetype` resolves as `(name, filetype)` before `(name, resource)` before `(name,)`. `examples/{python,typescript}/filetype/` register a `.tally` renderer end to end and are gated in CI against `integ/truth/*/filetype.txt`; `tests/commands/custom/test_filetype_fns.py` and `test_unregister_removes_all_filetypes` cover the unit path.

## History

Command history is a recording, not a command log. A hidden `Observer` records every top-level command as timestamp-ordered events (`COMMAND`, `CLEAR`, `DELETE`, op events); the user-facing surfaces are just views of those events.

- **Observer + ObserverStore.** The `Observer` owns a storage-agnostic `ObserverStore` (`append`/`write`/`readAll`/`readMatching`/`clear`/`close`), not a mount. Stores: `RAMObserverStore` (core, default), `DiskObserverStore` and `RedisObserverStore` (node). RAM is just the default, history can persist to disk or Redis.
- **Two views over the same events.** `/.bash_history` is a read-only view mount (`HistoryViewResource`) rendered in GNU bash histfile format (`#<epoch>` line then the command), so `cat`/`grep`/`tail`/`find` work on it for free. The `history` shell builtin (GNU `-c -d -a -n -r -w -s -p` + count) routes through the same mount, so file and builtin never disagree.
- **Recording scope.** Top-level lines record; nested evals (`$()`, `eval`, `source`, `xargs`) run with `record: false`, so their inner ops bubble to the parent and no spurious command is logged (mirrors GNU's line reader).
- **Snapshots.** History is captured as events into snapshot state and restored on load.
- **Format is GNU bash, not zsh** (`#<epoch>`, not `: <ts>:<dur>;<cmd>`).

## FUSE

- **Directory and unknown sizes.** `getattr` reports `st_size` 0 for directories and for API-backed size-unknown files that have not been opened recently. Reads stay correct because Python mounts with `direct_io` (kernel reads to EOF regardless of st_size) AND `attr_timeout=0` (post-open fstat routes to `getattr(path, fh)`, which serves the real size of the open-hydrated content); prefetched bytes live in a 30s TTL cache (`PREFETCH_TTL`) so release-then-stat does not refetch. All three pieces are load-bearing: without `attr_timeout=0`, `wc -c` prints 0, BSD `cp` copies 0 bytes, and `tail -c` dumps the whole file; without `direct_io`, `cat` reads 0 bytes on macOS. Do not "fix" getattr to report real sizes eagerly (one API fetch per `ls -l` entry), and do not report fake sizes: stat-only tools (`tar`, `rsync`, `test -s`) seeing 0 matches procfs precedent. TypeScript uses the same recipe: `@zkochan/fuse-native` doesn't serialize a `direct_io` option, so `mount.ts` appends it to the option string at runtime (`appendDirectIO`; a pnpm patch would not reach consumers), plus `attrTimeout: '0'` + fgetattr. The old 100 MiB sentinel is gone; do not reintroduce it.
- **TS FUSE mounts are served by the mounting process's event loop.** Never touch your own mountpoint synchronously (`readFileSync`, `statSync`, `execFileSync`) from the process that created the mount: the call deadlocks the loop that must answer it, the kernel times out, and every later op fails with `Device not configured`/`ENOTCONN` — which looks exactly like a broken mount. Probe from a child process or use async APIs (see `examples/typescript/fuse/helper.ts`). Python is immune (FUSE loop runs on a thread).
- **`FileStat.size` must be the rendered content's byte length or `None`, never a storage-side or source-side number.** A confidently wrong size is worse than an unknown one: over FUSE it makes `wc -c`/`ls -l` lie and risks truncated copies, while `None` rides the unknown-size machinery above. Postgres `rows.jsonl` (on-disk `table_size_bytes` vs rendered JSONL), Dify documents (uploaded source size vs rendered segment text), Gmail messages (`sizeEstimate` vs rendered `.gmail.json`), Drive-rendered google-apps files (Drive storage size vs rendered `.gdoc/.gsheet/.gslide` JSON; raw binary downloads keep Drive's size), and Microsoft Graph folders (OneDrive/SharePoint report an aggregate subtree `size` on the folder facet, not any content length) made this mistake; their storage/source numbers now live in `extra` (`size_bytes` / `source_size` / `size_estimate`). Do not reintroduce it in new backends. Graph's `folder.childCount` rides along in `extra` too, and is what `find -empty` reads for a directory.
- **macOS allows only one FUSE mount per process.** The second mount dies with `fuse: cannot register signal source` (mfusepy registers libfuse signal handlers, which only the first mount in a process can claim). Multi-mount scenarios (`integ/fuse.py` mounts two) pass only on Linux; do not debug them as regressions on macOS. A failed run leaks the first mount: list with `mount | grep MirageFS`, clean with `umount <mountpoint>`.
- **Windows (WinFsp) conventions differ in three ways**, all handled in the python mount path (`_prepare_mountpoint`, `_await_ready`, the teardown branches): the mountpoint must NOT exist (WinFsp creates it; an existing dir fails with "mount point in use"), `os.path.ismount` never sees WinFsp directory mounts (readiness = bare existence), and there is no `fusermount` (WinFsp unmounts when the serving process exits). Ownership: mount with `uid=-1,gid=-1` (WinFsp builtin: files owned by the mounting user); never report raw POSIX ids into the SFU/Cygwin SID mapping, and `os.getuid` does not exist there (MirageFS caches a guarded uid/gid once). Behavior quirk: Windows cannot stat without opening a handle, so size-unknown files hydrate on first stat and report their real size even "pre-open" (multi-mount per process works). The `integ-fuse-windows` job is advisory (not in the gate).

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

- **Shell-style commands** (cat, grep, du, find, head, tail, wc, ls, etc.) follow POSIX / Unix coreutils semantics as much as possible; match BSD/GNU behavior and document any deliberate divergence. Pin exact GNU behavior with docker (`debian:stable-slim`) before changing command semantics.
- **`find -size` is strict and rounds up.** GNU `+N` keeps `ceil(size/unit) > N`, `-N` keeps `ceil(size/unit) < N`, bare `N` keeps `ceil(size/unit) == N` (so `-size -1k` matches only empty files and `+0c` excludes empty ones). The parsers (`_parse_size` / `parseSize`) translate this once into inclusive byte bounds; backend cores just keep `min_size <= size <= max_size` and must not re-interpret the spec. Deliberate divergence: directories count as size 0 (GNU compares the inode size, e.g. 4096 on ext4), which matches what `find` sees over a mirage FUSE mount.
- **`du` has one backend contract: `size` and `entries`.** Each backend exposes `core/<backend>/du/size.py` (recursive byte total for one path) and `core/<backend>/du/entries.py` (per-file breakdown), wired as `du_size` / `du_entries` on the adapter. `entries` returns `(entries, total)` where entries are **leaf files only, in mount-relative path space, with no summary row**; the generic lifts them onto virtual paths (`to_virtual`, via `mount_prefix_of`) and re-spells them as the operand was typed (`respell_raw`). A backend that returns backend-key paths, or appends its own roll-up row, makes two mounts holding the same filename render identical lines. Do not reintroduce a second shape; the old flat-list `du_multi` contract is gone.
- **`du` prints a line per directory, derived not walked.** GNU prints one line per directory with its recursive total, post-order (children before parents), plus one per file under `-a`. Backends only ever report leaf files, so the generic derives the directory rows by summing each leaf into every ancestor (`rollup`, same name both languages), then emits post-order with siblings sorted. Two deliberate divergences: GNU orders siblings by `readdir` (filesystem-dependent), mirage sorts them; and an empty directory is invisible to mirage because no leaf points at it. Sizes are bytes, not GNU's 1 KiB blocks, since an object store has no block size. `--max-depth` prunes only what is printed, never the walk, because every printed total still covers the whole subtree. Verify changes with the differential harness against `debian:stable-slim`: paths, exit codes and stderr must match GNU exactly.
- **`du` usage errors exit 1, not 2.** `du` is absent from `USAGE_EXIT`, which is correct: GNU du exits 1 for `-s` with `-a` ("cannot both summarize and show all entries"), `-s` with `--max-depth` ("warning: summarizing conflicts with --max-depth=N"), and a bad depth ("invalid maximum depth 'x'"). All three are raised by `parse_flags` / `parseDuFlags` *before* any I/O, mirroring GNU's option-parse order: the depth is parsed as the option is read, so a bad depth wins over the conflict checks. An unreadable operand is not a usage error: GNU names it (`du: cannot access 'x': No such file or directory`), prints every other operand, and exits 1, and still prints `0 total` under `-c` when every operand failed. With no operand at all, du measures the working directory; it never says "missing operand".
- **`du` walks are bounded.** Backends with no native du op are walked one `readdir` at a time, which on an API tree is one request per directory. `CommandIO.max_du_entries` caps that walk; when it trips, `du` prints what it accounted for, writes a notice to stderr and exits 1 (GNU's behavior for a tree it could not fully read), rather than hanging or silently reporting a wrong number. Slack sets a low cap (`DU_MAX_ENTRIES`) because it exposes a directory per conversation per day against a ~50/minute rate limit.
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
- **Command wrappers and flags.** The dispatcher passes parsed command-line flags as keyword arguments. Wrappers must declare dispatcher-injected parameters (`stdin`, `index`, `prefix`) explicitly in their signature — never fish them out of `**flags` with `.get()`. Treat `**flags: object` as an opaque bag of true command-line flags and forward it wholesale to the generic command. When a wrapper genuinely needs a flag value itself (e.g. a search push-down), read it through `FlagView` (`fl = FlagView(flags)` then `fl.as_bool("F")`, `fl.as_int("m")`, `fl.as_str("type")`, `fl.as_list("e")`) or a shared domain accessor like `pattern_arg` — never raw `flags.get(...)` / isinstance chains.
- **Generic commands own flag interpretation.** Backend wrappers are wiring only (glob resolution, backend I/O injection, pass-through of `texts` and `flags`); all flag semantics live in the generic command for that family, mirroring the TS generics. Adding or changing a flag should touch the spec and the generic, not N wrappers.
- **Generics parse flags once into a frozen struct.** Each generic defines a `@dataclass(frozen=True, slots=True)` flag struct plus a module-level `parse_flags(fl, ...)` (mirroring the TS `parseFlags` struct); the function body reads only struct attributes, never string keys. Construct the FlagView with the command's spec (`FlagView(flags, spec=SPECS["grep"])`) so a typo in a flag name raises KeyError instead of silently reading as False/None.
- **Never annotate a parameter as `object`.** Use the real type: a backend handle is `accessor: Accessor` (`mirage.accessor.base`), an index is `index: IndexCacheStore | None` (`mirage.cache.index`). Ignored variadics are still typed (`*texts: str`). `object` is only acceptable as the value type of an opaque flag bag (`**flags: object`).
