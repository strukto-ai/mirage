# routing

How a line reaches a runtime. The runners register two test runtimes:
`processbox` takes captured commands as argv, and `echobox` echoes a whole
line back.

| File            | Pins                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `external.json` | captured external commands: argv, pipeline stages, path policy, globs in text slots, interpreter scripts, builtins kept |
| `fallback.json` | a captured program in a pipeline; an external fallback keeps mirage's commands and is no program to `which` or `type`   |
| `line.json`     | whole-line capture (`*`), literal words, interpreter scripts                                                            |
| `defaults.json` | the default Python runtime per host: monty on python, pyodide on typescript                                             |
| `registry.json` | a registered runtime named like a builtin, listed as known; a builtin name cannot be shadowed                           |
| `syntax.json`   | a syntax error exits 2, keeps its whole message, and is reported before policy                                          |
