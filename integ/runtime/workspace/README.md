# workspace

The in-mirage runtime, which takes whatever no other runtime captures.

| File                | Pins                                                                                |
| ------------------- | ----------------------------------------------------------------------------------- |
| `captures.json`     | captures restrict which lines a Python or JavaScript runtime takes                  |
| `lockdown.json`     | a route program that refuses a line                                                 |
| `listing.json`      | `ls` and `find` keep going past a failing record                                    |
| `interpreters.json` | with no language runtime, no `python3` or `node` is on PATH, and each alias says so |
