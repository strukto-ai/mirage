# policy

What governs a line before and after it runs.

| File           | Pins                                                                                                                                                                                                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routing.json` | route policy and the `pre_execute` stage: per-line runtime arguments, a route program's answers and failures, one that reads the workspace, a coded placement, a Deny over a Route, placements that disagree, admission before placement, `add_runtime`, narrowed captures, nested evals |
| `hooks.json`   | `pre_command`, `pre_vfs`, `post_vfs` and `post_execute` hooks: locks, seals, redaction, caps, error modes, failing closed                                                                                                                                                                |
| `sync.json`    | the same hooks written as plain functions                                                                                                                                                                                                                                                |
| `limits.json`  | output caps per command: truncate or error, across `;`, `&&`, \`                                                                                                                                                                                                                         |
| `paths.json`   | a hidden path, a path rule and a read-only mount refuse a program's open as they refuse `ws.vfs` and the shell, and a listing leaves the hidden name out, a hidden mount's included; a hidden link in front of a `..` is as missing to the shell and a host program as any hidden name   |
