# sandbox

The whole-line door every sandbox shares: mirage hands the line, its
stdin, env and cwd to a box the user runs and reads back stdout, stderr and
the exit code. What the line touches lives on the box, not on a mount.

| File            | Pins                                                          | Runs on                                          |
| --------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| `line.json`     | echo, an exit code, quoting                                   | every box; quoting on ssh and e2b                |
| `stdin.json`    | piped stdin; no input closes stdin at start; empty input      | every box; the end-of-input cases on ssh and e2b |
| `env.json`      | config `env` reaches the line                                 | every box                                        |
| `timeout.json`  | a mount limit's timeout ends the line with 124                | every box                                        |
| `captures.json` | only captured commands go to the box; the rest stay in mirage | every box                                        |
| `kernel.json`   | the box runs its own Linux kernel                             | smolvm, apple_container                          |

The boxes are docker, ssh, e2b, smolvm and apple_container. CI runs docker
and ssh in `integ-runtime` against containers it starts, and e2b in
`integ-e2b` against E2B Embed, on the python host only (see the runtime
README); smolvm and apple_container run where their
host exists.
