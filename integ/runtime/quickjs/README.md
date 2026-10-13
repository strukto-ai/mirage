# quickjs

What only QuickJS has.

| File          | Pins                                                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `print.json`  | `print` and `puts` write raw; `printf`, more `printf` conversions                                                      |
| `argv.json`   | a stdin operand; typed argv that names no mount                                                                        |
| `invoke.json` | `--version` for `js` and `node`, stdin, module mode, classic scripts at `/`, errors, no Node globals, a missing script |
| `async.json`  | jobs past an `await` reach the mount; an error in one, or a rejected module, fails the run                             |
