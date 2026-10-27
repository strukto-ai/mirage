# LLM routing

A route policy asks a model where each `python3` line runs: `monty` when it can, `local` when it needs the host's Python.

Set `OPENAI_API_KEY` (OpenAI models) or `JEV_API_KEY` (Jev models) in `.env.development` at the repo root, then from the repo root:

```bash
./python/.venv/bin/python examples/python/policy/llm_routing/main.py --model gpt-6-luna
./python/.venv/bin/python examples/python/policy/llm_routing/main.py --model jev-latest
```

Tested on `gpt-6-luna` (2026-10-27):

```
$ python3 -c "print(sum(range(1, 101)))"
  plan: allow
    route monty: Monty supports the built-in `range`, `sum`, and `print` used by this code.
      by RoutePolicy
  output: 5050
$ python3 -c "import sqlite3; print(sqlite3.sqlite_version)"
  plan: allow
    route local: This code imports sqlite3, which is not available in Monty’s limited standard library.
      by RoutePolicy
  output: 3.50.4
```

Tested on `jev-latest` (2026-10-27). Jev gives no reason, so the reason is its confidence, 0 to 1:

```
$ python3 -c "print(sum(range(1, 101)))"
  plan: allow
    route monty: confidence 0.30
      by RoutePolicy
  output: 5050
$ python3 -c "import sqlite3; print(sqlite3.sqlite_version)"
  plan: allow
    route local: confidence 0.04
      by RoutePolicy
  output: 3.50.4
```

The reasons and confidences change from run to run. The last output is the host's SQLite version.
