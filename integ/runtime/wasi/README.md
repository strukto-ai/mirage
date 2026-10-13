# wasi

What only CPython on WASI has. Python host only.

| File           | Pins                                                                       |
| -------------- | -------------------------------------------------------------------------- |
| `imports.json` | the script's directory heads `sys.path`; a session `PYTHONPATH` adds to it |
| `mounts.json`  | a mount over the stdlib at `/lib` refuses the run; one beside it runs      |
