# facade

The SDK file API (`ws.vfs`), with no runtime in the way. A case with a `backends` list also runs over RAM, disk, ssh, S3 and redis, and over RAM, disk and redis with the file cache on.

| File            | Pins                                                                                                                                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `append.json`   | appends land on one ledger and create a missing file                                                                                                                                                                                                                |
| `probe.json`    | probes answer through the dispatcher                                                                                                                                                                                                                                |
| `pwrite.json`   | `pwrite` keeps the bytes around it and leaves zeros past the end; missing-file creation succeeds where supported and refuses with `ENOTSUP` on redis; an empty existing-file write reads and writes nothing; a directory is `EISDIR`; a negative offset is `EINVAL` |
| `rmdir.json`    | `rmdir` refuses a non-empty directory and a missing one, and removes an empty one                                                                                                                                                                                   |
| `truncate.json` | `truncate` cuts, grows with zeros, empties, and creates a missing file, as GNU `truncate` does without `-c`                                                                                                                                                         |

The Redis `pwrite` fallback does not support create-only replacement.
Both nonempty and empty writes to a missing file raise `ENOTSUP` and leave no file,
with or without the file cache. Redis implements native `append` and `truncate`,
so those operations still create missing files.
