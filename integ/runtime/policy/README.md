# policy

What governs a line before and after it runs.

| File           | Pins                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `routing.json` | route policy: per-line runtime arguments, entry scripts and their verdicts, a global policy, `add_runtime`, narrowed captures, nested evals |
| `hooks.json`   | `pre_command`, `pre_ops`, `post_ops` and `post_execute` hooks: locks, seals, redaction, caps, error modes, failing closed                   |
| `sync.json`    | the same hooks written as plain functions                                                                                                   |
| `limits.json`  | output caps per command: truncate or error, across `;`, `&&`, \`                                                                            |
