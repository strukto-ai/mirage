# local

What only the host's own interpreter has.

| File            | Pins                                                                                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoke.json`   | a host script is named after its workspace path; init switches reach it; `-m` runs a module or names the missing one; `argv[0]` and `__file__` as CPython has them; `command` and `unset -f` restore the handoff |
| `jobs.json`     | a killed job that is one host program: `wait` returns once it has stopped, with its own status when it handled the signal and 128 plus the signal otherwise                                                      |
| `policy.json`   | a stdin operand obeys path policy                                                                                                                                                                                |
| `programs.json` | a captured host program runs with stdin, a missing one or a cwd not on the host says why; without the capture only python3 goes to the host                                                                      |
