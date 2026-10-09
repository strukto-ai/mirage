# host

What only the SDK's in-process entry point has: `with ws:` on the python host and
`patchNodeFs` on the typescript one, which point the process's own `open`,
`os` and node `fs` at the mounts. A case gives a `python` and a `node`
program, and both answer alike.

| File         | Pins                                                                                                                                                                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `files.json` | reads, writes and appends reach the mount and its ledger; `mkdir -p`, rename, symlink, readlink, unlink and rmdir; utime, chmod and chown read back through stat and the shell                                                                              |
| `edges.json` | a copy crosses the mount's edge both ways and a rename across it is EXDEV, while host paths stay the host's; a mount root is EBUSY to rmdir and to a tree removal that holds one, with nothing removed; node's sync calls and watches refuse a mounted path |

The dispatcher serves mounted paths only: a path no mount owns, the structure
above the mounts and a relative path are the process's own. So the shared
cases that pin a guest's view of those (`open/view.json`, the structure
above mounts, `stat` of `/`, the working directory) do not list `host`, and
neither do `os.pread` and `os.pwrite`, since the entry point has no descriptors.
A mount made at `/` is the workspace's root, and both entry points serve every
path under it; the root the workspace adds when nothing is mounted there
stays the process's.
