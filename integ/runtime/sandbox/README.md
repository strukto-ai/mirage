# sandbox

The whole-line entry point every sandbox shares: mirage hands the line, its
stdin, env and cwd to a box the user runs and reads back stdout, stderr and
the exit code. What the line touches lives on the box, not on a mount,
unless the runtime's `mount_type` serves the mounts into it: `mounts.json`
checks hides, a read-only mount and a host change through it, and that
`both` refuses a line while a rule covers the box's own mount.

| File            | Pins                                                          | Runs on                                          |
| --------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| `line.json`     | echo, an exit code, quoting                                   | every box; quoting on ssh and e2b                |
| `stdin.json`    | piped stdin; no input closes stdin at start; empty input      | every box; the end-of-input cases on ssh and e2b |
| `env.json`      | config `env` reaches the line                                 | every box                                        |
| `timeout.json`  | a mount limit's timeout ends the line with 124                | every box                                        |
| `captures.json` | only captured commands go to the box; the rest stay in mirage | every box                                        |
| `kernel.json`   | the box runs its own Linux kernel                             | apple_container, microsandbox, smolvm            |
| `mounts.json`   | `mount_type` serves the session's view into the box           | docker, e2b, microsandbox                        |

The boxes are apple_container, docker, e2b, microsandbox, smolvm and ssh. CI runs docker
and ssh in `integ-runtime` against containers it starts, and e2b in
`integ-e2b` against E2B Embed, on the python host only (see the runtime
README); apple_container, microsandbox and smolvm run where their
host exists.
