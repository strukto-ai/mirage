# routing

How a line reaches a machine. The runners register two test runtimes:
`processbox` takes captured commands as argv, and `echobox` echoes a whole
line back.

| File            | Pins                                                                                                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `external.json` | captured external commands: argv, pipeline stages, path policy, globs in text slots, interpreter scripts, builtins kept, wrappers and where their programs are placed, a path Mirage has no file for |
| `fallback.json` | a captured program in a pipeline; an external fallback keeps mirage's commands and is no program to `which` or `type`                                                                                |
| `line.json`     | whole-line capture (`@line`), literal words, interpreter scripts                                                                                                                                     |
| `defaults.json` | a workspace with no machines runs no interpreter                                                                                                                                                     |
| `registry.json` | a registered runtime named like a builtin, listed as known; a builtin name cannot be shadowed                                                                                                        |
| `syntax.json`   | a syntax error exits 2, keeps its whole message, and is reported before policy                                                                                                                       |
