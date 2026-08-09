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

## Module Layout

Packages split by role, one module per concern, the same way in both languages:

- **`types.py`** — data shapes only: frozen dataclasses, type aliases, Literal unions (e.g. `runtime/types.py` holds `RunArgs`/`RunResult`/`EvalValue`/`EvalResult`/`ScriptSource`). No logic.
- **`errors.py`** — the package's exception types (e.g. `runtime/errors.py` holds `EvalError`, `policy/errors.py` holds `PolicyError`).
- **`config.py`** — configuration knobs and their coercion (e.g. `runtime/config.py` holds `RuntimeConfig`, which fails loud on unknown fields).
- **`mixin.py`** — opt-in capability mixins: stateless, no constructor, abstract methods only (e.g. `runtime/mixin.py` holds `EvaluatorMixin`). Capability is detected by type (`isinstance`), never by probing for a method.
- **`base.py`** — the package's core ABC and nothing else (e.g. `runtime/base.py` is just `Runtime`).

## History

Command history is a recording, not a command log. A hidden `Observer` records every top-level command as timestamp-ordered events (`COMMAND`, `CLEAR`, `DELETE`, op events); the user-facing surfaces are just views of those events.

- **Observer + ObserverStore.** The `Observer` owns a storage-agnostic `ObserverStore` (`append`/`write`/`readAll`/`readMatching`/`clear`/`close`), not a mount. Stores: `RAMObserverStore` (core, default), `DiskObserverStore` and `RedisObserverStore` (node). RAM is just the default, history can persist to disk or Redis.
- **Two views over the same events.** `/.bash_history` is a read-only view mount (`HistoryViewResource`) rendered in GNU bash histfile format (`#<epoch>` line then the command), so `cat`/`grep`/`tail`/`find` work on it for free. The `history` shell builtin (GNU `-c -d -a -n -r -w -s -p` + count) routes through the same mount, so file and builtin never disagree.
- **Recording scope.** Top-level lines record; nested evals (`$()`, `eval`, `source`, `xargs`) run with `record: false`, so their inner ops bubble to the parent and no spurious command is logged (mirrors GNU's line reader).
- **Snapshots.** History is captured as events into snapshot state and restored on load.
- **Format is GNU bash, not zsh** (`#<epoch>`, not `: <ts>:<dur>;<cmd>`).

## CLIs

An installed CLI is a typed program tree (`CLISpec`) bound to a head word on the
workspace. It is **dispatched by name, never by operand path**: the VFS is how an
agent discovers state, the CLI is how it acts.

- **An account CLI consults no mount; `git` is the one that does.** The two are
  different tiers, told apart by `config_model`. An account CLI
  (`slack`, `linear`, `gws`, …) declares one, initializes from it, and reaches a
  service, so a mount would be a second source of truth for the same account.
  `git` declares none, because there is nothing to authenticate to, and its
  subject is a repository that lives on a mount, so it reads that repository
  through the op dispatcher like any command. That is what makes `git` work on a
  RAM mount, a disk mount or an object store without knowing which. It reaches
  the dispatcher through `CLIVerbOpts` (`dispatch`, `stat_path`, `mount_root`),
  which `handle_cli`/`handleCli` puts on `inv.ops`; the field is None/absent
  outside a workspace, and a verb that never reads it cannot touch a mount, so
  this stays opt-in per verb rather than ambient. The door is one field read
  rather than a parameter list the dispatcher inspects, because every leaf takes
  exactly one `CLIInvocation` and nothing is threaded through keyword injection.
  Do not give an account CLI a mount, and do not give `git` a `config_model`.
  Nuance: an account CLI verb MAY read an unrelated workspace file the user
  named on the line through `inv.ops.dispatch` (himalaya's `--attach` reads the
  attachment path this way); what it must not do is treat a mount as a second
  view of its own account's data.

- **The lifecycle is host-side only.** `register_cli`/`unregister_cli`
  (`workspace.py`, `workspace.ts`) are called by the embedding program, never by
  a line the agent types, and there is no `install`/`uninstall` shell builtin.
  Keep it that way: an agent must not be able to take away the tools it was
  given. Shadowing is the one thing it can do (define a shell function with the
  same name), which is bash's own rule, reversible with `unset -f`, bypassable
  with `command <name>`, and visible in `type -a`. A deployment that needs a head
  word pinned enforces that in the policy layer's `pre_execute`, not in the CLI
  registry.

- **Precedence is written down once**, in `_layers`/`layers`
  (`workspace/route/route.py`, `route.ts`): shell builtin, namespace command,
  function, CLI, mount. `route` takes the first match (the winner, which is what
  dispatch runs) and `route_all`/`routeAll` takes all of them (every layer, which
  is what `type -a` prints). The generator is lazy so the winner still costs one
  probe. Do not add a second precedence list.

- **Discoverability is part of shipping a CLI**, and it comes from the spec, so
  it works for a user's own registered CLI exactly as for a builtin one. `man <cli>` and `man <cli> <verb>...` render through `node_help`/`nodeHelp`, the
  same renderer `--help` uses, so a manual cannot drift from the program; bare
  `man` lists installs under `# clis`. `type` reports an installed CLI as its own
  kind (`type -t` prints `cli`, a sixth word beside bash's five, because reusing
  `file` would promise `type -p` a path that does not exist). `which` prints the
  bare name, never a fabricated path.

## Mount boundaries

A mount root is not an ordinary directory, and a mount nested inside
another mount's tree is invisible to the backend that owns the parent:
the child's keys live in a different resource, so the parent's `readdir`
never lists it. Two mechanisms follow from that, and they are separate.

- **`MountView` is how a command sees the boundaries** (`ops/types.py`,
  `ops/types.ts`), and it is offered the way `LinkView` is: a command
  opts in by naming a `mounts` parameter, `execute_cmd`/`executeCmd`
  delivers it only to handlers that do, and there is no list of
  boundary-aware commands anywhere. It carries `descendants` (mount
  roots strictly under a path), `is_root`, and `root_of`.
  A traversal command that renders **lines** does not need it: the
  executor's fan-out (`workspace/executor/fanout.py`) already reruns
  find/du/tree/grep -r per mount and concatenates the output. A command
  whose output is one **binary object** cannot be merged that way, which
  is why `tar` reads the boundaries itself.
- **Crossing into a descendant mount is refused, not attempted.** `tar`
  and `zip` both keep the mountpoint as a directory entry and drop its
  contents with GNU's own `--one-file-system` wording (`<name>/: file is on a different filesystem; not dumped`; Info-ZIP has no message of
  its own for this, so zip borrows the wording under its own
  `zip warning:` prefix). This is deliberate: descending would archive
  by accident exactly what the mount-root refusal below forbids on
  purpose.
- **`MountRootPolicy` refuses a mount root in a source slot** for `tar -c`,
  `zip` and `cp`, on top of the POSIX EBUSY rules it already enforces
  for `rm`/`rmdir`/`mv`/`mkdir`/`touch`/`ln`. Real tar and cp allow it;
  mirage does not, because the mount table is the deployment's
  configuration and reading a whole backend into one object is neither
  what the operand looks like it costs nor something an agent should be
  able to do to data it was given a view of. Only **positional** operands
  are tested, which is why `CommandContext` carries `operands` beside
  `paths`: `tar -xf a.tar -C /mnt` extracts INTO a mount and must stay
  legal, while `tar -cf a.tar /mnt` must not. `positional_scopes` /
  `positionalScopes` (`executor/command/routing`) is what tells the two
  apart, since classification turns every path-shaped word into a
  PathSpec whether it filled an operand slot or a flag's value. Mode
  matters too: only `tar -c` reads its operands from the filesystem, so
  `is_create_mode` / `isCreateMode` gates the refusal. Under `-t` and
  `-x` an operand is a member selector matched inside the archive, and
  refusing one that happens to spell a mount root would deny an
  ordinary listing.

## An option that chdirs: `operand_base`

`tar -C` is not a flag the command reads once, it is a chdir for the path
operands typed **after** it, and it is cumulative (`-C d1 x -C ../d2 y`
reads `d1/x` and `d1/../d2/y`). That is a property of the line, so it is
declared in the spec (`CommandSpec.operand_base` / `operandBase`, tar's
only) and resolved by the one component that walks the line
positionally: `parse_command` / `parseCommand` tracks the base as it
scans and reports it per word as `word_bases` / `wordBases`, which
`classify_parts` then resolves each operand against. Doing it anywhere
later is too late: the classifier has already produced absolute
PathSpecs, and an operand resolved against the wrong base makes the
router see a phantom cross-mount span (which is what
`tar -czf /work/out.tgz -C /work/check my_paper` used to fail as).
Only path operands and the option's own value move; every other
path-valued flag keeps resolving against the session cwd, which is what
GNU does with `-f`.

## Symlinks

Symlinks are **namespace state, not backend state**. The `Namespace` node table
owns them (target stored verbatim as typed), no resource stores or reports one,
and no backend `readdir` or `stat` can see one. Three consequences, in the order
they bite:

- **A new resource needs no symlink code at all.** Links live above every
  backend, so a backend author never implements, stores, or forwards one. This
  is the whole point of keeping them in the namespace; do not push link
  awareness down into a resource or an accessor.
- **A command opts in by naming the parameter, nothing else.** Declare
  `links: LinkView | None = None` on the wrapper and the generic and the
  dispatcher starts passing it; delete the parameter and it stops. `execute_cmd`
  offers the fact to every handler and `accepts_kwarg` (`utils/params.py`)
  decides delivery from the signature, so there is no allowlist, spec field, or
  registry that can fall out of step. A bare `**kwargs` deliberately does not
  count as consent: every wrapper has one, and it is the opaque bag of the
  user's typed command-line flags, forwarded wholesale to the generic. Counting
  it would file a live namespace object among the parsed flags of every command
  in the repo. This is the same rule already stated for `stdin`/`index`/`prefix`
  under "Command wrappers and flags", and `stat_overlay` is delivered the same
  way.
  `LinkView` bundles every link fact (`stat_at`, `children`, `subtree`,
  `resolve`, `exists`, `target_stat`) so a command that grows a new need adds a
  field read, not a new keyword threaded through `execute_cmd`, the builder and
  the generic. Families wired today: `ls`, `stat`, `find`, `du`, `file`.
  `exists` and `target_stat` answer through the op dispatcher, not one
  backend's stat, so a link that points into another mount resolves correctly.
- **A bespoke command in one of those families must declare it too.** The
  opt-in is the whole mechanism, so a backend that ships its own `find`/`ls`/
  `du`/`stat`/`file` and omits the parameter still runs, still exits 0, and
  simply cannot see a link, which nothing notices until someone makes one on
  that backend. `tests/commands/test_links_optin.py` asserts it instead: it
  derives the link-aware names from the generic builders and fails naming any
  registered command that shadows one without accepting `links`. TypeScript
  needs no equivalent because wrappers forward the whole `opts` object, so a
  generic reads `opts.links` whatever the wrapper declares; the bespoke email
  find routes through `findGeneric`/`walkFind` like the factory, so no TS
  command walks its own tree any more.
- **Merge links in the generic, above the native-op/walk fork.** `find` and `du`
  each have two paths: a backend with a native op (`find_core`, `du_size`/
  `du_entries`) and a backend walked by `readdir`. Link merging lives in one
  shared place per family (`link_results` in `generic/find.py`, `link_leaves` in
  `generic/du.py`) that both paths call. Merging inside only one path makes a
  mount's symlink behavior depend on whether its backend happens to ship a
  native op, which is the worst kind of divergence to debug.

Follow policy is two symmetric tables in `workspace/route/constants.py`, both
read off the raw command line (operand rewriting happens before flag parsing):
`NO_FOLLOW_COMMANDS` lists commands that lstat (`rm`, `mv`, `ln`, `readlink`,
`rmdir`, `unlink`, `stat`, `file`, `du`, `find`, `tar`, `zip`), with
`DEREFERENCE_FLAGS` naming the flag that turns following back on (`-L`).
`tar` and `zip` are in that list for a different reason and deliberately carry
no `DEREFERENCE_FLAGS` entry: they dereference too, but their planner has to be
the one doing it. Rewriting the operand in the router hands the planner a
target it can no longer tell was reached through a link, so `tar` stored a
regular file where GNU stores a symlink member, and neither archiver could
apply its own cross-mount refusal or ELOOP wording. `tar -h` and `zip -y` are
read by `scan_operand` instead. `find` states its policy as
a leading `-P`/`-H`/`-L` option instead, last one wins, so it lives in
`LAST_WINS_LINK_OPTIONS`;
`NO_FOLLOW_FLAGS` is the mirror, for a following command that a flag makes lstat
(`ls -l` and `ls -d` report a command-line link itself, while a bare `ls`
dereferences a link to a directory, and `ls -L` overrides both).

Those tables only cover the *operand*; honoring `-L` below it is the generic's
job, not the router's.

Rendering derives from one fact: `link_stat` builds
the row with `FileType.SYMLINK` and the target under `FileStat.extra`
(`LINK_TARGET_KEY`), so `lrwxrwxrwx`, the `name -> target` column, `-F`'s `@`,
and `file`'s "symbolic link to" all follow from it without a second lookup.

`du` sizes a link at its target string's length. This is not a divergence:
mirage's `du` counts bytes, which is GNU's `--apparent-size --block-size=1`
(`du -b`) mode, and in that mode GNU reports a symlink as `len(target)` too. The
familiar `0` comes from GNU's default 1 KiB *block* mode, where a short target
sits inline in the inode and occupies no data blocks (`stat` reports
`size=15 blocks=0` for it). mirage has no block mode at all, so `0` is not an
option it can express; comparing against it would also make every regular file
look wrong (a 6-byte file is `6` in bytes, `4` in 1 KiB blocks).

## FUSE

- **The mount layer is split core/adapter in both languages.** `MountCore`
  (`python/mirage/fuse/core.py`, `typescript/packages/node/src/fuse/core.ts`)
  owns all filesystem semantics in POSIX terms and imports nothing from
  mfusepy or `@zkochan/fuse-native`; `MirageFS` in `fs.py`/`fs.ts` is the
  libfuse adapter and owns only the callback signatures plus errno
  translation. Core methods raise ordinary exceptions; adapters classify them
  through `classify_error`/`classifyErrno` (`fuse/errors.py`, `fuse/errors.ts`),
  which is one shared table, not per-method `except` arms. Put new filesystem
  behavior in the core, not the adapter.
- **One `backend` field per mount: `vfs | fuse | fskit`** (`MountBackend` in
  `mirage/types.py`, beside `MountMode`). `vfs` is the default and means the
  mount lives only inside mirage's own filesystem; `fuse` and `fskit` also
  register a real mountpoint, with `mountpoint` pinning where. There is no
  `fuse=True` boolean any more, and no `auto` backend.
  `Mount(..., backend=MountBackend.FSKIT)` routes through macFUSE 5.x's FSKit
  shim (no kernel extension). Rules live in `fuse/backend.py` and are enforced
  at mount time: macOS-only, mountpoint must be under `/Volumes`, and every
  mounted resource must set `SIZES_ALWAYS_KNOWN` (FSKit has no `direct_io`, so
  a size-unknown resource would serve silent empty files). `resolve_backend`
  rejects `vfs`: reaching it means a kernel mount was requested. In YAML the
  keys are `backend:` and `mountpoint:`.
  TypeScript serves fskit too: `fuse.node` links `/usr/local/lib/libfuse.2.dylib`
  by absolute path (the bundled `libosxfuse.2.dylib` is a stub with that
  install name), so `backend=fskit` + `volname` reach macFUSE 5.x's own
  libfuse via `appendMountOptions` in `mount.ts`. Verified live. Caveat: a TS
  fskit mount intermittently wedged on a write op in testing (probed from
  child processes), and a dead FSKit volume blocks mount-table enumeration
  system-wide until the macFUSE appex process is killed; treat fskit from TS
  as read-mostly and experimental.
  A mount is ready only when `os.path.ismount` says so, never when the
  `/Volumes` entry merely exists: macFUSE creates that directory while
  mounting and leaves it behind if the FSKit handoff fails, which reads as a
  live mount and then fails with ENOENT on the first read.
  **Python fskit mounts have the full write surface, and only because of
  `fuse/darwin.py`.** The FSKit shim finalizes every created item through
  macFUSE's Darwin-only `setattr_x` and routes rename through `renamex`;
  mfusepy leaves those `fuse_operations` slots as reserved NULLs, so without
  the extension module create/mkdir fail with ENOSYS *after* the op already
  applied and rename never reaches userspace (verified by libfuse wire
  trace: CREATE success, then SETATTR -78). Do not remove the
  `install_macfuse_extensions()` call in `mount.py`, and keep the struct
  tail in sync with macFUSE's fuse.h if mfusepy changes layout. Pinned in
  `integ/fuse/truth_fskit.json` on macFUSE 5.3.3 / macOS 26.
  TS fskit stays read-mostly: fuse-native's compiled op table cannot gain
  new C callbacks from JS. Upstream shim caveats that remain for both:
  exec-until-first-read fails (macfuse#1181) and root readdir cache cannot
  be invalidated (macfuse#1165).
  `integ/fuse/fskit.py` is the only coverage of a real FSKit mount, and it only
  runs on a Mac with macFUSE 5.x: on the `integ-fskit-macos` job a hosted
  runner installs and enables everything but the mount request never reaches
  macFUSE, so the job reports that one known timeout signature as a skip and
  stays green; any other failure there is real.
- **Directory and unknown sizes.** `getattr` reports `st_size` 0 for directories and for API-backed size-unknown files that have not been opened recently. Reads stay correct because Python mounts with `direct_io` (kernel reads to EOF regardless of st_size) AND `attr_timeout=0` (post-open fstat routes to `getattr(path, fh)`, which serves the real size of the open-hydrated content); prefetched bytes live in a 30s TTL cache (`PREFETCH_TTL`) so release-then-stat does not refetch. All three pieces are load-bearing: without `attr_timeout=0`, `wc -c` prints 0, BSD `cp` copies 0 bytes, and `tail -c` dumps the whole file; without `direct_io`, `cat` reads 0 bytes on macOS. Do not "fix" getattr to report real sizes eagerly (one API fetch per `ls -l` entry), and do not report fake sizes: stat-only tools (`tar`, `rsync`, `test -s`) seeing 0 matches procfs precedent. TypeScript uses the same recipe: `@zkochan/fuse-native` doesn't serialize a `direct_io` option, so `mount.ts` appends it to the option string at runtime (`appendDirectIO`; a pnpm patch would not reach consumers), plus `attrTimeout: '0'` + fgetattr. The old 100 MiB sentinel is gone; do not reintroduce it.
- **TS FUSE mounts are served by the mounting process's event loop.** Never touch your own mountpoint synchronously (`readFileSync`, `statSync`, `execFileSync`) from the process that created the mount: the call deadlocks the loop that must answer it, the kernel times out, and every later op fails with `Device not configured`/`ENOTCONN` — which looks exactly like a broken mount. Probe from a child process or use async APIs (see `examples/typescript/fuse/helper.ts`). Python is immune (FUSE loop runs on a thread).
- **`FileStat.size` must be the rendered content's byte length or `None`, never a storage-side or source-side number.** A confidently wrong size is worse than an unknown one: over FUSE it makes `wc -c`/`ls -l` lie and risks truncated copies, while `None` rides the unknown-size machinery above. Postgres `rows.jsonl` (on-disk `table_size_bytes` vs rendered JSONL), Dify documents (uploaded source size vs rendered segment text), Gmail messages (`sizeEstimate` vs rendered `.gmail.json`), Drive-rendered google-apps files (Drive storage size vs rendered `.gdoc/.gsheet/.gslide` JSON; raw binary downloads keep Drive's size), and Microsoft Graph folders (OneDrive/SharePoint report an aggregate subtree `size` on the folder facet, not any content length) made this mistake; their storage/source numbers now live in `extra` (`size_bytes` / `source_size` / `size_estimate`). Do not reintroduce it in new backends. Graph's `folder.childCount` rides along in `extra` too, and is what `find -empty` reads for a directory.
- **macOS allows only one FUSE mount per process.** The second mount dies with `fuse: cannot register signal source` (mfusepy registers libfuse signal handlers, which only the first mount in a process can claim). Multi-mount scenarios (`integ/fuse/fuse.py` mounts two) pass only on Linux; do not debug them as regressions on macOS. A failed run leaks the first mount: list with `mount | grep MirageFS`, clean with `umount <mountpoint>`.
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
- **`find`'s row for the start point is the generic's, not the backend's.** GNU lists a start point before descending into it, and every native find op used to decide that row from its own listing, which is only a proxy for existence: an object store holding no keys under the prefix and no directory marker reported nothing at all for a directory `test -d` and `tree` both saw, and ssh called every directory non-empty so `-empty` never matched one. The generic stats the start point through the dispatcher (`resolve_start`, which asks both channels a backend can answer on via `resolve_path_stat`, since on a prefix store a directory is the set of keys under it rather than an object), takes one readdir for `-empty` (`dir_empty`, wired by the builder), and then replaces whatever row the backend produced for it (`with_root_row` / `withRootRow`). A native find op may still emit the start path and they all do, because it is the answer when no dispatcher probe is wired (a command constructed outside a workspace); with one wired it is discarded. A new backend only has to report descendants.
- **`find` classifies walked entries through `stat`, never by name.** The
  walk's one in-band proof is a trailing slash on a cold listing (box, gdrive
  and dropbox mark folders that way, and no backend renders a file with one);
  every other entry is classified by the index-backed `stat` that the same
  readdir just populated, so the lookup is RAM, not another API call. There is
  no per-backend `is_dir_name`/`isDirName` hint: those heuristics guessed
  wrong as soon as a child's name was user-controlled (email and gmail
  attachments and slack uploads carry whatever name the sender gave them, and
  were reported as directories, so `find -type f` missed them). Do not
  reintroduce name-based classification in a backend; if stat misclassifies an
  entry, fix that backend's stat.
- **An archiver walks a directory operand; it does not read it.** `tar`
  and `zip` decide every member first (`plan_create` / `planCreate` in
  `generic/tar/create.*`, `plan_zip` / `planZip` in
  `generic/zip_cmd.*`) and only then write, which is what lets an
  exclusion prune a whole subtree and keeps the ordering stable. Both
  plans are built on **one traversal**, `scan_operand` / `scanOperand`
  (`generic/archive/walk.*`), which merges three sources no single one
  can see: the backend walk (reusing find's `walk_find` / `walkFind`, so
  an archiver classifies an entry through `stat` exactly as find does,
  never by name), the namespace's symlinks, and the mount table. It
  reports paths, never names, because naming is exactly where the two
  formats disagree; the two things they disagree about in the traversal
  itself are parameters (`dereference`, `recurse`), so **a third
  archiver adds a caller, not a second walk**. Members are named from
  `PathSpec.raw_path`, so `tar -C d x` stores `x`, not `d/x`.
  **A directory is its own member**, with GNU's trailing slash and no
  content, which is the only record an empty directory leaves and the
  reason extraction has to `mkdir` for one. **A symlink is a symlink
  member** (`SYMTYPE`, target in `linkname`), never a file of its
  target's bytes, unless `-h` says to follow it.
  **Two links to one target are not a loop**, and both are archived; the
  only loop is one `resolve` refuses to resolve, since the namespace
  already walks the chain under a hop limit and raises `CycleError` at
  the end of it. That arrives as a fatal `Problem` carrying GNU's
  `Too many levels of symbolic links`, reported per member with the
  directory entry kept, rather than as an exception that aborts the
  plan. **Every `-C` is checked, not just the last**: GNU chdirs at each
  one and fails at the first it cannot enter, so the option accumulates
  (`multiple=True`) and the planner walks the list.
  Two deliberate divergences from GNU, both documented in place:
  siblings are sorted rather than emitted in readdir order (the same
  choice `du` makes, for the same reason), and a descendant mount is
  never crossed (see "Mount boundaries"). Everything else is pinned
  against GNU tar 1.35 on `debian:stable-slim`: the leading-slash
  warning, `Cowardly refusing to create an empty archive` (exit 2), a
  per-operand `Cannot stat` plus one trailer (exit 2, and the other
  operands still archive), a `-C` it cannot enter (exit 2, no archive
  written), and `archive cannot contain itself; not dumped` (exit 0).
  A backend error must never reach the user as itself: an unreadable
  operand is reported in virtual path space with tar's wording, because
  the raw `IsADirectoryError` leaked the host path behind a disk mount.
- **`zip` is Info-ZIP, which inverts tar's two defaults.** A directory
  operand contributes only its own entry unless `-r` says to descend,
  and a symlink is *followed* unless `-y` says to store the link, where
  tar always descends and always stores unless `-h`. Both are just the
  `recurse` / `dereference` arguments to the shared scan. The rest is
  pinned against Info-ZIP 3.0 on `debian:stable-slim`: a leading slash
  is stripped **in silence** (tar warns, zip does not), `-j` junks to
  the basename and drops directory entries entirely, `-x` is
  **anchored** on the whole stored name (`d/sub/*` matches, `sub/*` does
  not) where tar's `--exclude` is unanchored, an unreachable operand is
  `\tzip warning: name not matched: <name>` and does not stop the run,
  and a run that matched nothing prints `zip error: Nothing to do!`,
  exits **12**, and writes no archive. `-q` silences the warnings but
  never that error. Two deliberate divergences: `-x` takes one pattern
  per occurrence (mirage's spec has no variadic option value, and
  `-x a -x b` says the same thing), and the `adding:` line carries no
  `(deflated N%)` suffix, since the ratio depends on the compressor and
  would differ between the two languages.
- **Tar formats come from a library, not from hand-rolled block code, and
  bzip2 is read-only in TypeScript.** Python builds archives with stdlib
  `tarfile`; TypeScript uses `modern-tar` behind `tar_helper.ts`, which
  keeps the `TarEntry` shape (`name`/`data`/`isFile`/`isDir`/`linkname`)
  the two call sites already speak and is the only place the dependency
  is named. Do not go back to writing ustar blocks by hand: the version
  that did truncated any name past 100 bytes instead of using the ustar
  `prefix` field or a PAX header (so a deep member extracted to the wrong
  path), and read a PAX/GNU extension block as if it were a member (so
  `tar -t` on any archive GNU or Python wrote listed a phantom
  `././@PaxHeader` row). `writeTar`/`readTar` are async for this reason.
  Compression is a registry (`registerCompressionCodec`): gzip is built
  in via `CompressionStream`, and a codec may be **decompress-only**,
  which is the one deliberate py/ts divergence here. Python reads and
  writes `.tar.bz2` because `bz2` is stdlib; TypeScript only reads one,
  because every JavaScript bzip2 *compressor* is GPL (`compressjs`,
  `archive-wasm`) and an Apache-2.0 package cannot ship that, while
  `seek-bzip` (MIT) decodes. `tar -cj` therefore exits 1 with
  `tar: bzip2 not supported`, the same answer browser core already gives
  for an unregistered codec. If a permissively licensed bzip2 compressor
  appears, adding `compress` to that one codec closes the gap with no
  other change.
- **The TypeScript `walkFind` answers in mount-relative keys; the Python
  `walk_find` answers in virtual paths.** TS's stands in for a backend's
  native find op, so a caller that needs virtual paths (tar does, to
  name members and compare against mount prefixes) lifts them with
  `mountPrefixOf` the way `findGeneric` does. That lift lives once, in
  `generic_bind/archive_io.*`, which is where both archivers get their
  walk. This asymmetry is real and has bitten once: a unit test on an
  unprefixed mount cannot see it, so cover a prefixed mount too.
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
- **Command wrappers and flags.** The dispatcher passes parsed command-line flags as keyword arguments. Wrappers must declare dispatcher-injected parameters (`stdin`, `index`, `prefix`) explicitly in their signature — never fish them out of `**flags` with `.get()`. Treat `**flags: FlagValue` as an opaque bag of true command-line flags and forward it wholesale to the generic command. A wrapper must not name a flag it cannot receive: the parser maps every spelling onto one canonical dest (the long form whenever an option declares one), so a parameter named after a short spelling with a long twin is permanently unfilled — `tests/commands/test_no_dead_flag_params.py` fails on one. When a wrapper genuinely needs a flag value itself (e.g. a search push-down), read it through `FlagView` (`fl = FlagView(flags)` then `fl.as_bool("F")`, `fl.as_int("m")`, `fl.as_str("type")`, `fl.as_list("e")`) or a shared domain accessor like `pattern_arg` — never raw `flags.get(...)` / isinstance chains, and never a raw `kwargs`/`_extra` read either (`tests/commands/test_no_raw_flag_reads.py` matches all three bag names). **A PATH-typed flag reaches a python command as a `PathSpec`, not a string** — the executor promotes it (`workspace/executor/command/flags.py`), so read it with `fl.as_paths(name)`; `as_str` reads it as absent and the operand is silently never used. TypeScript's bag carries the resolved virtual-path string instead, so its twin is `fl.asStr(name)`.
- **Generic commands own flag interpretation.** Backend wrappers are wiring only (glob resolution, backend I/O injection, pass-through of `texts` and `flags`); all flag semantics live in the generic command for that family, mirroring the TS generics. Adding or changing a flag should touch the spec and the generic, not N wrappers.
- **Generics parse flags once into a frozen struct.** Each generic defines a `@dataclass(frozen=True, slots=True)` flag struct plus a module-level `parse_flags(fl, ...)` (mirroring the TS `parseFlags` struct); the function body reads only struct attributes, never string keys. Construct the FlagView with the command's spec (`FlagView(flags, spec=SPECS["grep"])`) so a typo in a flag name raises KeyError instead of silently reading as False/None.
- **Never annotate anything as `object`** — not a parameter, not a return, not a type argument (`dict[str, object]`, `Callable[..., object]`). `object` reads as "we did not decide": it accepts bytes where JSON was meant and a PathSpec where a flag value was meant, so every use site pays for it with an isinstance chain back to the set the author had in mind. Name the real type instead:
  - a parsed command-line flag is `FlagValue` (`mirage.commands.spec.types`) — `**flags: FlagValue`, `Mapping[str, FlagValue]`, `FlagValue | None` for a single raw read. The TypeScript side has always called it `FlagValue` too (`commands/spec/types.ts`); keep the two spellings identical.
  - a decoded JSON payload or an API field is `JsonValue` (`mirage.types`). It is recursive, so it is spelled as a forward-reference string until the floor is 3.12 — a union with it must be quoted: `Awaitable["JsonValue | X"]`.
  - a path is `str | PathSpec`, a backend handle is `accessor: Accessor` (`mirage.accessor.base`), an index is `index: IndexCacheStore | None` (`mirage.cache.index`), a stat function is `StatFn` (`mirage.types`). Ignored variadics are still typed (`*texts: str`).
  - a sentinel is a one-member `Enum`, never `object()`; that keeps it distinguishable from the real values sharing the variable.
    `tests/commands/test_no_object_annotations.py` enforces this and carries the only exemptions: four Python protocol methods (`__setattr__`, `__contains__`, `Mapping.pop`) whose signatures the language fixes, and one guard whose whole job is to catch a value the annotations already claim cannot arrive. Adding to that allowlist needs the same kind of reason.
