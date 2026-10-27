# LLM routing

A route policy asks a model where each `python3` line runs: `monty` when it can, `local` when it needs the host's Python.

Set `OPENAI_API_KEY` in `.env.development` at the repo root, then from the repo root:

```bash
./python/.venv/bin/python examples/python/policy/llm_routing/main.py
```

Tested on `gpt-6-luna` (2026-10-27):

```
$ python3 -c "print(sum(range(1, 101)))"
  plan: allow
    route monty: Monty supports the Python built-ins `print`, `sum`, and `range`, so it can run this line.
      by RoutePolicy
  output: 5050
$ python3 -c "import sqlite3; print(sqlite3.sqlite_version)"
  plan: allow
    route local: This command imports sqlite3, which requires the host Python runtime rather than Monty's limited standard library.
      by RoutePolicy
  output: 3.50.4
```

The reasons are the model's own words and change from run to run. The last output is the host's SQLite version.
