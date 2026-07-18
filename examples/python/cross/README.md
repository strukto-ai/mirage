# Cross-resource workspace (CLI)

Drive a multi-mount workspace (`/s3`, `/gdrive`, `/gmail`, `/slack`,
`/discord`) end-to-end from the shell using `workspace.yaml`.

The two CLIs expose the same workspace HTTP API. Each
example below shows the **Python** CLI (`mirage`, on `$PATH`) and
the **TypeScript** CLI (`./mirage-ts`, a symlink to
`typescript/packages/cli/dist/bin/mirage.js` from the repo root).
Pick whichever CLI is convenient for the run; the command shapes match.

## Prereqs

- `.env.development` at the repo root with `AWS_`\*, `GOOGLE_*`,
  `SLACK_BOT_TOKEN`, `DISCORD_BOT_TOKEN`.
- Python: `mirage` CLI on `$PATH` (e.g. `./python/.venv/bin/mirage`).
- TypeScript: `pnpm --filter @struktoai/mirage-cli build` then
  `ln -sf typescript/packages/cli/dist/bin/mirage.js mirage-ts`
  at the repo root (already gitignored).

## 1. Source env and create the workspace

The YAML's `${...}` placeholders resolve from your shell at create
time, so source first.

```bash
set -a && source .env.development && set +a
```

```bash
mirage       workspace create examples/python/cross/workspace.yaml --id cross
./mirage-ts  workspace create examples/python/cross/workspace.yaml --id cross
```

## 2. Inspect

```bash
mirage       workspace list
./mirage-ts  workspace list
```

```bash
mirage       workspace get cross
./mirage-ts  workspace get cross
```

## 3. Run commands across mounts

`/gdrive/` is index-first — list it once before reading individual
files, otherwise paths resolve to ENOENT.

```bash
mirage       execute --workspace_id cross --command "ls /s3/"
./mirage-ts  execute --workspace_id cross --command "ls /s3/"
```

```bash
mirage       execute --workspace_id cross --command "ls /gdrive/"
./mirage-ts  execute --workspace_id cross --command "ls /gdrive/"
```

```bash
mirage       execute --workspace_id cross --command "head -n 1 /s3/data/example.jsonl"
./mirage-ts  execute --workspace_id cross --command "head -n 1 /s3/data/example.jsonl"
```

```bash
mirage       execute --workspace_id cross \
  --command 'cat /s3/data/example.jsonl "/gdrive/AWS CDK.gdoc.json" | wc -l'
./mirage-ts  execute --workspace_id cross \
  --command 'cat /s3/data/example.jsonl "/gdrive/AWS CDK.gdoc.json" | wc -l'
```

## 4. Dry-run with `provision`

```bash
mirage       provision --workspace_id cross --command "cat /s3/data/example.jsonl | wc -l"
./mirage-ts  provision --workspace_id cross --command "cat /s3/data/example.jsonl | wc -l"
```

After a real read the same path flips from a network read to a cache
hit (`cache_hits=1`):

```bash
mirage       execute   --workspace_id cross --command "cat /s3/data/example.jsonl > /dev/null"
./mirage-ts  execute   --workspace_id cross --command "cat /s3/data/example.jsonl > /dev/null"
```

```bash
mirage       provision --workspace_id cross --command "cat /s3/data/example.jsonl"
./mirage-ts  provision --workspace_id cross --command "cat /s3/data/example.jsonl"
```

## 5. Snapshot and restore

Snapshots redact cloud creds at snapshot time, so loading needs fresh
creds via a config file. The same workspace YAML used for create works.

```bash
mirage       workspace snapshot cross /tmp/cross.tar
./mirage-ts  workspace snapshot cross /tmp/cross.tar
```

```bash
mirage       workspace load /tmp/cross.tar examples/python/cross/workspace.yaml \
  --id cross_loaded
./mirage-ts  workspace load /tmp/cross.tar examples/python/cross/workspace.yaml \
  --id cross_loaded
```

```bash
mirage       workspace get cross_loaded --verbose
./mirage-ts  workspace get cross_loaded --verbose
```

## 6. Clean up

The daemon exits ~30s after the last workspace is deleted.

```bash
mirage       workspace delete cross
./mirage-ts  workspace delete cross
```

```bash
mirage       workspace delete cross_loaded
./mirage-ts  workspace delete cross_loaded
```

## 7. Per-mount safeguards (Python CLI)

A mount can cap what a command streams back with `command_safeguards`,
so a runaway `cat`/`grep`/`rg` can't flood the agent or hang forever.
Each entry sets `max_lines` / `max_bytes` (output cap) and/or
`timeout_seconds` (deadline), with `on_exceed: truncate` (stop, exit 0,
add a notice) or `on_exceed: error` (stop, exit 1, add a notice).

This section is **Python-only**: the TS config schema does not yet carry
`command_safeguards`. It runs against its own workspace
(`cross_sg`) from [workspace_safeguards.yaml](workspace_safeguards.yaml),
so the steps above are untouched. That file guards `/s3` with:
`head` → 10 lines / truncate, `grep` → 20 lines / error, `rg` → a 1 ms
timeout.

```bash
set -a && source .env.development && set +a
mirage workspace create examples/python/cross/workspace_safeguards.yaml --id cross_sg
```

Warm the object once (the first S3 read fetches the whole object and can
take a few seconds; later reads are cache hits):

```bash
mirage execute --workspace_id cross_sg --command "head -n 1 /s3/data/example.jsonl"
```

`max_lines` + `on_exceed: truncate` — asking for 50 lines yields 10 plus a
notice on stderr, exit `0`:

```bash
mirage execute --workspace_id cross_sg --command "head -n 50 /s3/data/example.jsonl"
```

`max_lines` + `on_exceed: error` — `grep` matches thousands of lines, trips
the 20-line cap, and fails with exit `1`:

```bash
mirage execute --workspace_id cross_sg --command "grep mirage /s3/data/example.jsonl"
```

`timeout_seconds` — the 1 ms deadline trips on any real read, exit `124`
with `rg: timed out after 0.001s`:

```bash
mirage execute --workspace_id cross_sg --command "rg mirage /s3/data/example.jsonl"
```

Commands below their cap are untouched, so the earlier shapes still work
unchanged (1 line, no notice):

```bash
mirage execute --workspace_id cross_sg --command "head -n 1 /s3/data/example.jsonl"
```

Clean up:

```bash
mirage workspace delete cross_sg
```

## 8. Versioning (Python CLI)

The daemon keeps a git-backed history per workspace under
`~/.mirage/repos/<id>` (set `MIRAGE_HOME` to relocate the whole data
tree). You commit
the live state as a version, then `log` / `diff` / `branch` / `checkout`,
following git. See the [CLI docs](https://docs.mirage.strukto.ai) for the
full reference.

This section is **Python-only** and runs against its own scratch workspace
(`cross_ver`) from
[workspace_versioning.yaml](workspace_versioning.yaml), so the steps above
are untouched. It uses a writable RAM mount: versioning tracks the workspace
tree regardless of backend, and this keeps the demo fast and writes nothing
to your real cloud backends.

> The history outlives the workspace: `workspace delete` does **not** remove
> `~/.mirage/repos/<id>`. Re-creating the same id resumes the old history, so
> this walkthrough starts from a clean id (or `rm -rf ~/.mirage/repos/cross_ver`
> first) to keep output predictable.

```bash
mirage workspace create examples/python/cross/workspace_versioning.yaml --id cross_ver
```

Commit two versions, then `log` (newest first):

```bash
mirage execute --workspace_id cross_ver --command "echo v1 > /notes.txt"
mirage workspace commit cross_ver -m "first"

mirage execute --workspace_id cross_ver --command "echo v2 > /notes.txt"
mirage workspace commit cross_ver -m "second"

mirage workspace log cross_ver
```

`diff` reports changed paths (added / modified / deleted). With no refs it
compares the live state to the branch HEAD; with two version ids it compares
those versions (substitute the ids `log` printed):

```bash
mirage workspace diff cross_ver                 # live vs HEAD (clean: all empty)
mirage workspace diff cross_ver <v1> <v2>       # => modified: ["notes.txt"]
```

`branch` forks at a branch's current version; commit onto it with `-b`. `main`
is left untouched:

```bash
mirage workspace branch cross_ver exp
mirage execute --workspace_id cross_ver --command "echo on-exp > /notes.txt"
mirage workspace commit cross_ver -b exp -m "on exp"
mirage workspace log cross_ver -b exp           # on exp, second, first
mirage workspace log cross_ver                  # main unchanged: second, first
```

`checkout` restores the live state in place to a version or branch
(overwriting uncommitted changes):

```bash
mirage workspace checkout cross_ver <v1>
mirage execute --workspace_id cross_ver --command "cat /notes.txt"   # => v1
```

`clone --at` builds a new workspace from one of the source's past versions
(omit `--at` to clone the live state):

```bash
mirage workspace clone cross_ver --at <v1> --id cross_ver_at
mirage execute --workspace_id cross_ver_at --command "cat /notes.txt" # => v1
```

Clean up (and drop the histories so a rerun starts fresh):

```bash
mirage workspace delete cross_ver
mirage workspace delete cross_ver_at
rm -rf ~/.mirage/repos/cross_ver ~/.mirage/repos/cross_ver_at
```

## SDK alternative

The same flow driven from Python (with snapshot fingerprinting) lives
in [example.py](example.py) + [load_check.py](load_check.py).
