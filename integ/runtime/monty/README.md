# monty

What only Monty has. Monty is a Python subset, so a missing module or call
here is Monty's to add upstream; the cases pin the working forms.

| File           | Pins                                                                                                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoke.json`  | the default world, the `python` alias, file names, `-m` refused by name; `--version`, `-h`, a missing script, refused and unknown options in CPython's words, a shadowing function                                      |
| `argv.json`    | the `argv` global, script argv, typed argv that names no mount, interpreter flags before a script                                                                                                                       |
| `stdin.json`   | piped stdin. Monty has no `sys.stdin`: its input arrives whole, as the `stdin` global, so it cannot read an endless writer's; on the typescript host the engine refuses input over 256 MiB (its worker's request frame) |
| `env.json`     | the session environment                                                                                                                                                                                                 |
| `limits.json`  | a timeout; a loop of 1500 file reads finishes                                                                                                                                                                           |
| `surface.json` | the CPython surface Monty lacks, what it has, `os.urandom`                                                                                                                                                              |
| `policy.json`  | relative writes and script operands obey path policy; a script rule reads the operand as typed                                                                                                                          |
