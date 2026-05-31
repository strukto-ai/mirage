# Mirage CLI

`mirage` is the command-line client for the Mirage daemon. It talks to a local
daemon over HTTP and auto-spawns one on first use if none is running.

## Basic usage

```bash
# A minimal workspace config (workspace.yaml)
cat > workspace.yaml <<'YAML'
mounts:
  /:
    resource: ram
    mode: WRITE
YAML

# Create a workspace (spawns the daemon if needed)
mirage workspace create ./workspace.yaml --id myws

# Run a command in it
mirage execute -w myws -c 'echo hello'

# Inspect / clean up
mirage workspace list
mirage workspace get myws
mirage workspace delete myws

# Stop the daemon
mirage daemon stop
```

Other command groups: `session`, `provision`, `daemon`, plus
`workspace clone|snapshot|load`. Run `mirage <command> --help` for details.

## Environment variables

| Variable                    | Default                   | Purpose                                                                           |
| --------------------------- | ------------------------- | --------------------------------------------------------------------------------- |
| `MIRAGE_DAEMON_URL`         | `http://127.0.0.1:8765`   | Daemon address the CLI connects to                                                |
| `MIRAGE_TOKEN`              | (none)                    | Bearer token the CLI sends to the daemon                                          |
| `MIRAGE_AUTH_MODE`          | `local`                   | Daemon auth mode: `local`, `token`, or `jwt`                                      |
| `MIRAGE_AUTH_TOKEN`         | (auto-minted in `local`)  | Token the daemon accepts                                                          |
| `MIRAGE_IDLE_GRACE_SECONDS` | `30`                      | Seconds the daemon waits after its last workspace is removed before shutting down |
| `MIRAGE_ALLOWED_HOSTS`      | `127.0.0.1,localhost,::1` | Daemon Host-header allowlist (CSV; `*` disables the check)                        |
