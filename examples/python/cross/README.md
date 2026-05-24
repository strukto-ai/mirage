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

## SDK alternative

The same flow driven from Python (with snapshot fingerprinting) lives
in [example.py](example.py) + [load_check.py](load_check.py).
