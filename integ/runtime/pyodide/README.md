# pyodide

What only Pyodide has. TypeScript host only.

| File           | Pins                                                                                                                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mounts.json`  | no mount preload; the cwd falls back without a root mount                                                                                                                                            |
| `streams.json` | a JSON tool closes its output; output after memory growth (also read by `pyodide_streams.test.ts`)                                                                                                   |
| `env.json`     | each command's environment stays its own; each call starts with a clean interpreter                                                                                                                  |
| `errors.json`  | user tracebacks; `sys.exit` sets the status                                                                                                                                                          |
| `invoke.json`  | a script file names the program; flags and import paths are scoped; `-O` reaches imported modules; `--version`, no input, a missing script, `-W` and `-X`, a shadowing function and the handoff back |
| `argv.json`    | typed argv that names no mount: relative, globbed and cross-mount operands                                                                                                                           |
| `network.json` | the socket layer refuses: connect, sendto and urlopen say the network is unreachable; listen, a UDP bind and socketpair that it is down; a TCP bind still answers                                    |
