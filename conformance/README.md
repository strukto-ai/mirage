# Command Conformance Spec

One declarative spec for command behavior, run by both the Python and
TypeScript implementations (issue #151). Each case pins the exact bytes of
stdout, the exact bytes of stderr, and the exit code — so trailing newlines,
empty output, and binary output are all part of the contract.

## Runners

- Python: `python/tests/conformance/test_conformance.py` runs every case
  against `ram` and `disk`, plus `redis` when `REDIS_URL` is set. Runs as part
  of `uv run pytest`.
- TypeScript: `typescript/packages/node/src/conformance.test.ts` runs every
  case against `ram`. Runs as part of `pnpm test`.

## Files

- `seeds.json` — files written into the workspace before every case, via the
  ops/fs write API (not shell commands). Values are `{"text": ...}` for UTF-8
  content or `{"base64": ...}` for binary content.
- `cases/<command>.json` — cases for one command:

```json
{
  "command": "wc",
  "cases": [
    {
      "id": "wc_default",
      "cmd": "wc /data/a.txt",
      "matrix": { "python": ["ram", "disk", "redis"], "typescript": ["ram"] },
      "expect": {
        "exit": 0,
        "stdout_text": " 5  5 24 /data/a.txt\n",
        "stderr_text": ""
      }
    }
  ]
}
```

- `stdout` / `stderr` use exactly one of `*_text` (UTF-8) or `*_base64`
  (arbitrary bytes). Trailing newlines are significant.
- `stdin_text` / `stdin_base64` optionally feed stdin to the command.
- `matrix` is explicit: a case runs only on the listed backends. Listing a
  backend is a claim of support — a missing command there is a failure, not a
  skip. A case whose matrix is empty is a load-time error in both runners.

## Policy

- One expected value per case. If a backend or language legitimately diverges,
  that divergence is triaged first: either it is a bug (fix the
  implementation) or it is intended semantics (document it and add an explicit
  per-backend override mechanism — not yet needed).
- This spec is an acceptance/parity net, not a replacement for backend tests.
  API call counts, pushdown/fallback, cache invalidation, error injection, and
  concurrency stay in hand-written per-backend tests.
- `spec/` (command definitions exported from the registries) is a different
  artifact: it describes the command *surface*; this folder describes command
  *behavior*.

## Adding a backend

Add a backend when its command behavior should be compared against the same
expectations as the existing implementations:

1. Add its name to `SUPPORTED_MATRIX` in the Python and/or TypeScript runner.

1. Add runner setup that constructs a fresh workspace and resets backend state
   between cases.

1. For API-backed resources, use mocked clients with payloads shaped like real
   provider responses. Do not call live APIs from this suite.

1. Add the backend to the applicable case matrices:

   ```json
   "matrix": {
     "python": ["ram", "disk", "redis", "github"],
     "typescript": ["ram", "github"]
   }
   ```

1. Run the focused Python and TypeScript conformance tests.

Both runners are discovered by the existing Python and TypeScript CI test jobs;
no workflow change is required.

Only add a backend to a case when both should produce the same exact stdout,
stderr, and exit code. Keep provider-specific API calls, cache behavior, error
injection, and concurrency in backend tests.
