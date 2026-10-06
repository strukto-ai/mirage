# program

What one guest program gets from the line that runs it, the same on every
runtime that runs programs.

| File          | Pins                                                                                                                                                     | Runs on                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `argv.json`   | `sys.argv` for a `-c` program with arguments                                                                                                             | wasi, local, sandlock                                                                                                         |
| `output.json` | stdout through a pipe to `grep`; output kept and the runtime reusable after a failure; closed stdout and stderr, binary output, an exit code after close | monty, wasi, pyodide, quickjs, local; the closed-output case on wasi, pyodide and local (Monty's `sys.stderr` has no `write`) |
| `eval.json`   | a one-line program prints its result                                                                                                                     | monty, wasi, pyodide, quickjs, local                                                                                          |
