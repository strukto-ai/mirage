# policy

What governs a line before and after it runs.

| File           | Pins                                                                                                                                                                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routing.json` | route policy and the `pre_execute` stage: per-line runtime arguments, entry scripts and their verdicts, a global policy, a coded placement, a Deny over a Route, placements that disagree, admission before placement, `add_runtime`, narrowed captures, nested evals |
| `hooks.json`   | `pre_command`, `pre_ops`, `post_ops` and `post_execute` hooks: locks, seals, redaction, caps, error modes, failing closed                                                                                                                                             |
| `sync.json`    | the same hooks written as plain functions                                                                                                                                                                                                                             |
| `limits.json`  | output caps per command: truncate or error, across `;`, `&&`, \`                                                                                                                                                                                                      |
