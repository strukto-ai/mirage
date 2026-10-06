# Cross-VFS workspace (CLI)

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

## 4. Snapshot and restore

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

## 5. Clean up

The daemon exits ~30s after the last workspace is deleted.

```bash
mirage       workspace delete cross
./mirage-ts  workspace delete cross
```

```bash
mirage       workspace delete cross_loaded
./mirage-ts  workspace delete cross_loaded
```

## 6. Per-mount command limits (Python CLI)

A mount can cap what a command streams back with `command_limits`,
so a runaway `cat`/`grep`/`rg` can't flood the agent or hang forever.
Each entry sets `max_lines` / `max_bytes` (output cap) and/or
`timeout_seconds` (deadline), with `on_exceed: truncate` (stop, exit 0,
add a notice) or `on_exceed: error` (stop, exit 1, add a notice).

Both CLIs parse and apply the same `command_limits` block (the cross
harness pins this). This walkthrough uses the Python CLI against its own
workspace (`cross_sg`) from [workspace_limits.yaml](workspace_limits.yaml),
so the steps above are untouched. That file guards `/s3` with:
`head` → 10 lines / truncate, `grep` → 20 lines / error, `rg` → a 1 ms
timeout.

```bash
set -a && source .env.development && set +a
mirage workspace create examples/python/cross/workspace_limits.yaml --id cross_sg
```

Warm the object once (the first S3 read fetches the whole object and can
take a few seconds; later reads are cache hits):

```bash
mirage shell --workspace_id cross_sg --command "head -n 1 /s3/data/example.jsonl"
```

`max_lines` + `on_exceed: truncate` — asking for 50 lines yields 10 plus a
notice on stderr, exit `0`:

```bash
mirage shell --workspace_id cross_sg --command "head -n 50 /s3/data/example.jsonl"
```

`max_lines` + `on_exceed: error` — `grep` matches thousands of lines, trips
the 20-line cap, and fails with exit `1`:

```bash
mirage shell --workspace_id cross_sg --command "grep mirage /s3/data/example.jsonl"
```

`timeout_seconds` — the 1 ms deadline trips on any real read, exit `124`
with `rg: timed out after 0.001s`:

```bash
mirage shell --workspace_id cross_sg --command "rg mirage /s3/data/example.jsonl"
```

Commands below their cap are untouched, so the earlier shapes still work
unchanged (1 line, no notice):

```bash
mirage shell --workspace_id cross_sg --command "head -n 1 /s3/data/example.jsonl"
```

Clean up:

```bash
mirage workspace delete cross_sg
```

## SDK alternative

The same flow driven from Python (with snapshot fingerprinting) lives
in [example.py](example.py) + [load_check.py](load_check.py).
