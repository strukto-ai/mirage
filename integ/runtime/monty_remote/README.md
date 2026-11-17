# monty_remote

Monty on a remote server (`provider: monty_remote`). The suite runs against
`integ/server/monty_remote/relay.py`, monty's own gRPC relay, which bridges
each session to a local `monty subprocess`; `MONTY_REMOTE_URL` names it, and
the suite is skipped without it.

| File          | Pins                                                                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `remote.json` | a remote run reads, writes and lists mounts, a read-only mount refuses its write, env and stdin arrive; a timeout ends a run; an unreachable server exits 1 |

Start the relay from the repo root with the venv's `monty` on `PATH`:

```bash
PATH="$PWD/python/.venv/bin:$PATH" python/.venv/bin/python integ/server/monty_remote/relay.py --port 8799
```

Then run with `MONTY_REMOTE_URL=http://127.0.0.1:8799`.
