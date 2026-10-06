# sandlock

A host process under Landlock. Needs the Sandlock CLI and Landlock ABI v6;
set `MIRAGE_INTEG_SANDLOCK` on such a host.

| File                | Pins                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `landlock.json`     | a granted path is writable, an ungranted write is refused, mirage's env is not inherited |
| `interpreters.json` | real CPython, not a subset; node's argv                                                  |
| `fallback.json`     | an external fallback keeps the mount pipeline                                            |
