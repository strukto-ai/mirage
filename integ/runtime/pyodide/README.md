# pyodide

What only Pyodide has. TypeScript host only.

| File           | Pins                                                                                                                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mounts.json`  | no mount preload; the cwd falls back without a root mount                                                                                                                                                      |
| `streams.json` | a JSON tool closes its output; output after memory growth (also read by `pyodide_streams.test.ts`)                                                                                                             |
| `env.json`     | each command's environment stays its own; each call starts with a clean interpreter                                                                                                                            |
| `errors.json`  | user tracebacks; `sys.exit` sets the status                                                                                                                                                                    |
| `invoke.json`  | a script file names the program; flags and import paths are scoped; `-O` reaches imported modules; `--version`, no input, a missing script, `-W` and `-X`, a shadowing function and the handoff back           |
| `argv.json`    | typed argv that names no mount: relative, globbed and cross-mount operands                                                                                                                                     |
| `network.json` | the socket layer refuses: connect, sendto and HTTP say the network is unreachable; HTTPS has no usable transport (0.29 has no handler); listen, UDP bind and socketpair say it is down; TCP bind still answers |
