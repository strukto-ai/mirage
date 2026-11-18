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
error, though the program saw it succeed. The box keeps its own `/tmp`, and
the workspace shows it as a machine mount (`local.json`): sshfs does not
serve over it, a file a program writes there is the file Mirage reads, and a
line runs from it. Mirage leaves no files of its own there
(`captures.json`): its named pipes go in the machine user's `~/.mirage`.
A file mounted at a path of its own, such as `VFS.md`, stays in the
workspace: sshfs mounts only a directory. A link whose target leaves its
folder, by a `..` or an absolute path, reaches the box as a link, which
sshfs refuses since the fix for CVE-2026-47187 unless told otherwise, and an
absolute target resolves on the box's own disk. A served file shows as owned by the box's user, so git
takes a repository there as its own. A rename over an existing name lands, through the
posix-rename extension the server names.

| File              | Pins                                                                                                                                                                                            | Runs on                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `line.json`       | echo, an exit code, an unserved cwd exits 126, quoting, a rule after a `cd`, output bytes unchanged                                                                                             | every box; quoting on ssh, e2b and kubernetes; bytes on the boxes with perl |
| `stdin.json`      | piped stdin; no input closes stdin at start; empty input                                                                                                                                        | every box; the end-of-input cases on ssh, e2b and kubernetes                |
| `stream.json`     | a captured program's output and input flow as it runs; `head` ends it in the box                                                                                                                | every box; live output on the Debian boxes                                  |
| `env.json`        | config `env` reaches the line; a `PATH` with no `sh` still runs it                                                                                                                              | every box                                                                   |
| `timeout.json`    | a mount limit's timeout ends the line with 124                                                                                                                                                  | every box                                                                   |
| `connection.json` | a line whose connection drops ends with 129 and `connection lost`, keeping the output it read; the next line reconnects                                                                         | ssh, where a line can end its own session                                   |
| `captures.json`   | only captured commands go to the box; the rest stay in mirage; a pid two machines share takes `-m`                                                                                              | every box                                                                   |
| `kernel.json`     | the box runs its own Linux kernel                                                                                                                                                               | smolvm, microsandbox, apple_container                                       |
| `resources.json`  | `nproc`, `free`, `uptime` and `top` read the box; `$!`, a `kill` of `timeout` and `pkill -f` reach the program                                                                                  | docker, ssh, e2b, microsandbox, apple_container, kubernetes                 |
| `mounts.json`     | `mount_type` serves the session's view into the box                                                                                                                                             | docker, e2b, microsandbox, kubernetes                                       |
| `local.json`      | `/tmp`, `/dev/shm` and a machine mount at its own path are the box's own files; a machine tree at another prefix; two machines merge, refuse an ambiguous name, rename in place and copy across | docker, e2b, microsandbox, kubernetes; two machines on docker               |

The boxes are docker, ssh, e2b, smolvm, microsandbox, apple_container and kubernetes. CI runs docker
and ssh in `integ-runtime` against containers it starts, and the rest in
`integ-sandboxes`: e2b against E2B Embed, on the python host only (see the
runtime README), microsandbox on a guest it creates, and kubernetes on a pod
in a kind cluster;
smolvm and apple_container run where their host exists.
