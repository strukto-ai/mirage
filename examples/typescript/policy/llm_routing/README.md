# LLM routing

A route policy asks a model where each `python3` line runs: `monty` when it can, `local` when it needs the host's Python. It loads the Python example's `workspace.yaml` and `route.py`.

Set `OPENAI_API_KEY` in `.env.development` at the repo root, then:

```bash
cd examples/typescript && pnpm install && pnpm exec tsx policy/llm_routing/main.ts
```

Tested on `gpt-6-luna` (2026-10-27):

```
$ python3 -c "print(sum(range(1, 101)))"
  plan: allow
    route monty: Monty supports this Python expression using built-ins only; it prints the sum of the integers from 1 through 100.
      by RoutePolicy
  output: 5050
$ python3 -c "import sqlite3; print(sqlite3.sqlite_version)"
  plan: allow
    route local: The command imports `sqlite3`, a standard-library module that requires runtime support beyond Monty's limited Python subset.
      by RoutePolicy
  output: 3.53.4
```

The reasons are the model's own words and change from run to run. The last output is the host's SQLite version.
