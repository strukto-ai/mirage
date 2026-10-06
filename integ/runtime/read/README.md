# read

Reads that reach a mount. Runs on monty and quickjs on both hosts, wasi on the python host and pyodide on the typescript host. A case with a `backends` list also
runs over RAM, disk, ssh, S3 and redis.

| File         | Pins                                                                                                                                                                                           | Differs                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `read.json`  | `read`, `read_text`, `read_bytes`, line iteration (`getline` in QuickJS) and QuickJS `read` into an `ArrayBuffer`; a read touches only the files it opens; a file over 1 MiB is read in ranges | monty: file objects are not iterable, and there is no `glob` module. On S3 a second read comes from the cache |
| `pread.json` | `seek` then `read(n)`, a seek from the end and past it, `os.pread` leaving the position alone, reads across a 1 MiB chunk edge                                                                 | monty: no `os.open`, `os.pread` or `os.lseek`; `seek` and `tell` work                                         |
