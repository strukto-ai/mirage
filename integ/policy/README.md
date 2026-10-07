# Policy

What governs a line before and after it runs. All shared policy cases live
here; the existing lifecycle and runtime runners exercise their respective
API and shell execution paths.

| File           | Pins                                                                                                                                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cases.json`   | profiles, command and path rules, approvals and their scope, mount modes, VFS and tool access, coded and script policies, placement, explain and function approval identity                                                               |
| `routing.json` | route policy and `pre_execute`: per-line runtime arguments, entry scripts and verdicts, global and coded policies, Deny over Route, conflicting placements, admission before placement, `add_runtime`, narrowed captures and nested evals |
| `hooks.json`   | `pre_command`, `pre_vfs`, `post_vfs` and `post_execute`: locks, seals, redaction, caps, error modes and failing closed                                                                                                                    |
| `sync.json`    | the same hooks written as plain functions                                                                                                                                                                                                 |
| `limits.json`  | output caps per command: truncate or error, sequences, conditionals, pipes, groups, functions, substitutions, redirects, background jobs, mount and profile limits                                                                        |

`cases.json` uses the lifecycle step format (`settings`, `op`, `expect.value`).
Run it on Python and both TypeScript hosts (Node and browser) from the repo root:

```sh
PYTHONPATH=python ./python/.venv/bin/python integ/lifecycle/run.py integ/policy/cases.json
(cd integ && pnpm exec tsx lifecycle/run.ts policy/cases.json)
```

The other JSON files use the runtime step format (`world`, `command`, shell
expectations). The runtime runners discover them here, retaining the
`policy/<file>` suite names and the `policy` selector:

```sh
PYTHONPATH=python ./python/.venv/bin/python integ/runtime/run.py policy
(cd integ && pnpm exec tsx runtime/run.ts policy)
PYTHONPATH=python bash integ/runtime/cli.sh \
  "./python/.venv/bin/mirage" \
  "node typescript/packages/cli/dist/bin/mirage.js" policy
```

Build the TypeScript packages first. The CLI runner exercises cases that
can be expressed through workspace YAML and shell commands; cases requiring
SDK-only policies, runtimes or assertions retain their existing skips.
`cases.json` runs in the `integ` and `integ-ts` CI jobs; the other files run
through Python, TypeScript and both CLIs in `integ-runtime`. Changes to the
policy JSON files trigger all of those jobs; documentation changes alone do
not trigger the runtime job.
