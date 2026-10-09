# facade

The SDK file API (`ws.vfs`), with no runtime in the way. A case with a `backends` list also runs over RAM, disk, ssh, S3 and redis.

| File            | Pins                                                                                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `append.json`   | appends land on one ledger and create a missing file                                                                                                                                    |
| `probe.json`    | probes answer through the dispatcher                                                                                                                                                    |
| `pwrite.json`   | `pwrite` keeps the bytes around it, leaves zeros past the end and creates a missing file; an empty one reads and writes nothing; a directory is `EISDIR`; a negative offset is `EINVAL` |
| `rmdir.json`    | `rmdir` refuses a non-empty directory and a missing one, and removes an empty one                                                                                                       |
| `truncate.json` | `truncate` cuts, grows with zeros, empties, and creates a missing file, as GNU `truncate` does without `-c`                                                                             |
