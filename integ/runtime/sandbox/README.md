# sandbox

The whole-line entry point every sandbox shares: mirage hands the line, its
stdin, env and cwd to a box the user runs and reads back stdout, stderr and
the exit code. What the line touches lives on the box, not on a mount,
unless the runtime's `mount_type` serves the mounts into it: `mounts.json`
checks hides, a read-only mount and a host change through it, that `both`
refuses a line while a rule covers the box's own mount, and that a line
over a served mount the box lost since the mounts were last read, its
sshfs still running as a restart between check and run leaves it, exits
126 without running and the next line serves it again. A write sshfs
acknowledged and could not land (a capped mount) fails its line with the
error, though the program saw it succeed.

| File              | Pins                                                                                                                    | Runs on                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `line.json`       | echo, an exit code, an unserved cwd exits 126, quoting, a rule after a `cd`, output bytes unchanged                     | every box; quoting on ssh and e2b; bytes on the boxes with perl |
| `stdin.json`      | piped stdin; no input closes stdin at start; empty input                                                                | every box; the end-of-input cases on ssh and e2b                |
| `stream.json`     | a captured program's output and input flow as it runs; `head` ends it in the box                                        | every box; live output on the Debian boxes                      |
| `env.json`        | config `env` reaches the line; a `PATH` with no `sh` still runs it                                                      | every box                                                       |
| `timeout.json`    | a mount limit's timeout ends the line with 124                                                                          | every box                                                       |
| `connection.json` | a line whose connection drops ends with 129 and `connection lost`, keeping the output it read; the next line reconnects | ssh, where a line can end its own session                       |
| `captures.json`   | only captured commands go to the box; the rest stay in mirage                                                           | every box                                                       |
| `kernel.json`     | the box runs its own Linux kernel                                                                                       | smolvm, microsandbox, apple_container                           |
| `mounts.json`     | `mount_type` serves the session's view into the box                                                                     | docker, e2b, microsandbox                                       |

The boxes are docker, ssh, e2b, smolvm, microsandbox and apple_container. CI runs docker
and ssh in `integ-runtime` against containers it starts, e2b in
`integ-e2b` against E2B Embed, on the python host only (see the runtime
README), and microsandbox in `integ-microsandbox` on a guest it creates;
smolvm and apple_container run where their host exists.
