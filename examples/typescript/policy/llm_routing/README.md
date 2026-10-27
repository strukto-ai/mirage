# LLM routing

A route policy asks a model where each `python3` line runs: `monty` when it can, `local` when it needs the host's Python. It loads the Python example's `workspace.yaml` and `route.py`.

Set `OPENAI_API_KEY` (OpenAI models) or `JEV_API_KEY` (Jev models) in `.env.development` at the repo root, then:

```bash
cd examples/typescript && pnpm install
pnpm exec tsx policy/llm_routing/main.ts --model gpt-6-luna
pnpm exec tsx policy/llm_routing/main.ts --model jev-latest
```

Tested on `gpt-6-luna` (2026-10-27):

```
$ python3 -c "print(sum(range(1, 101)))"
  plan: allow
    route monty: The code uses only basic Python built-ins supported by Mirage's sandbox.
      by RoutePolicy
  output: 5050
$ python3 -c "import sqlite3; print(sqlite3.sqlite_version)"
  plan: allow
    route local: Use local because Monty's limited standard library does not include sqlite3.
      by RoutePolicy
  output: 3.53.4
```

Tested on `jev-latest` (2026-10-27). Jev gives no reason, so the reason is its confidence, 0 to 1:

```
$ python3 -c "print(sum(range(1, 101)))"
  plan: allow
    route monty: confidence 0.28
      by RoutePolicy
  output: 5050
$ python3 -c "import sqlite3; print(sqlite3.sqlite_version)"
  plan: allow
    route local: confidence 0.00
      by RoutePolicy
  output: 3.53.4
```

The reasons and confidences change from run to run. The last output is the host's SQLite version.
