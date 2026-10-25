# policy

What governs a line before and after it runs.

| File           | Pins                                                                                                                                                                                                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routing.json` | route policy and the `pre_execute` stage: per-line runtime arguments, a route program's answers and failures, one that reads the workspace, a coded placement, a Deny over a Route, placements that disagree, admission before placement, `add_runtime`, narrowed captures, nested evals |
| `hooks.json`   | `pre_command`, `pre_vfs`, `post_vfs` and `post_execute` hooks: locks, seals, redaction, caps, error modes, failing closed                                                                                                                                                                |
| `sync.json`    | the same hooks written as plain functions                                                                                                                                                                                                                                                |
| `limits.json`  | output caps per command, truncating or failing, across lists and pipelines; an interpreter's timeout, named after the command                                                                                                                                                            |
| `paths.json`   | a hidden path, a path rule and a read-only mount refuse a program's open as they refuse `ws.vfs` and the shell, and a listing leaves the hidden name out, a hidden mount's included; a hidden link in front of a `..` is as missing to the shell and a host program as any hidden name   |

`cached_reads.json` warms file caches and retained descriptors, then changes hides,
path denials and pre/post-VFS hooks before reading again. It checks commands, Git,
facade calls, host handles, MountCore and FUSE callbacks on RAM and disk. Backend
read counters distinguish retained reads from refetches. Guest programs exercise
current hook refusals; changing their session permissions cancels the invocation,
and restoring access permits a new invocation. Control-file hooks and retained
handle steps are SDK-only fixtures, so the CLI/daemon runner skips them. Retained
metadata is checked before and after unlink, hide and stat-hook refusal.

`shortcuts.json` exercises native head, tail, line count, checksum, search and
follow operations with no hooks, then checks cold and warm reads under separately
registered pre- and post-VFS hooks. Recursive search includes inverse matches and
files without matches, so a native index cannot reveal a denied file.
