# local

What only the host's own interpreter has.

| File          | Pins                                                                                                                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoke.json` | a host script is named after its workspace path; init switches reach it; `-m` runs a module or names the missing one; `argv[0]` and `__file__` as CPython has them; `command` and `unset -f` restore the handoff |
| `policy.json` | a stdin operand obeys path policy                                                                                                                                                                                |
