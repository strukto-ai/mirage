# cli

Script CLIs: a program installed under a head word.

| File          | Pins                                                                                                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `python.json` | named by its head word; flags, its own help, config in the environment, piped stdin, two installs, a pinned runtime, no runtime exits 127; portable globals on pyodide and local |
| `js.json`     | a JavaScript CLI on quickjs gets its name and flags; pinned to a Python runtime it exits 127                                                                                     |
