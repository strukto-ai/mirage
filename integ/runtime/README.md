# Runtime

These suites run what mirage hands to a runtime against mirage mounts: a
guest program (Python on monty, wasi, pyodide and local, JavaScript on
quickjs) or a whole line (the sandboxes). Every case runs through `run.py`
(the python host), `run.ts` (the typescript host) and `cli.sh` (both CLIs
and their daemons).

## Layout

A folder is a topic or a runtime, the way `integ/vfs/` keeps a folder per
topic or backend:

- A **topic folder** holds cases several runtimes share. Each case lists
  them in `runtimes`, and the runners run it once per runtime.
- A **runtime folder** holds what only that runtime has.

Each folder's README lists what its files cover and where a runtime
differs.

| Folder                                 | Kind    | Covers                                                                                            |
| -------------------------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| [`open/`](open/)                       | topic   | open modes `r`, `r+`, `w`, `w+`, `a`, `a+`, `x`, malformed modes, paths outside the view          |
| [`read/`](read/)                       | topic   | whole-file and line reads, seek and ranged reads                                                  |
| [`write/`](write/)                     | topic   | writes through each API, `pwrite`, `truncate`, files left open at exit, read-only and root mounts |
| [`dir/`](dir/)                         | topic   | listing, `mkdir`, `rmdir`, glob and walk                                                          |
| [`path/`](path/)                       | topic   | stat, rename, unlink, symlinks, hard links, times and modes, xattrs, the working directory        |
| [`program/`](program/)                 | topic   | what one program gets: argv, output streams, eval                                                 |
| [`sandbox/`](sandbox/)                 | topic   | the whole-line door every sandbox shares                                                          |
| [`routing/`](routing/)                 | topic   | how a line reaches a runtime                                                                      |
| [`policy/`](policy/)                   | topic   | route policy, hooks and output limits                                                             |
| [`config/`](config/)                   | topic   | runtime names and config fields that are refused                                                  |
| [`cli/`](cli/)                         | topic   | script CLIs in Python and JavaScript                                                              |
| [`backend/`](backend/)                 | topic   | guest reads and writes on real redis, S3 and MongoDB                                              |
| [`facade/`](facade/)                   | topic   | the SDK op facade                                                                                 |
| [`monty/`](monty/)                     | runtime | Monty's invocation, argv, streams, policy and Python surface                                      |
| [`wasi/`](wasi/)                       | runtime | CPython on WASI: import paths                                                                     |
| [`pyodide/`](pyodide/)                 | runtime | Pyodide's mounts, streams, environment, tracebacks and flags                                      |
| [`quickjs/`](quickjs/)                 | runtime | QuickJS invocation, printing, argv and policy scripts                                             |
| [`local/`](local/)                     | runtime | the host's own interpreter                                                                        |
| [`workspace/`](workspace/)             | runtime | the in-mirage runtime: captures, lockdown, listings                                               |
| [`sandlock/`](sandlock/)               | runtime | Landlock limits on a host process                                                                 |
| [`apple_container/`](apple_container/) | runtime | Apple's container: stderr, sessions, an unserved cwd                                              |
| [`e2b/`](e2b/)                         | scripts | manual checks against a live E2B sandbox, not run by the runners                                  |

## Runtimes

| Runtime                              | Python host                                   | TypeScript host                                |
| ------------------------------------ | --------------------------------------------- | ---------------------------------------------- |
| monty                                | `pydantic_monty`, file calls via OS callbacks | `@pydantic/monty`, file calls via OS callbacks |
| wasi                                 | CPython built for WASI, in wasmtime           | not on this host                               |
| pyodide                              | not on this host                              | Pyodide, Emscripten FS with a journal          |
| quickjs                              | `qjs` from quickjs-ng built for WASI          | quickjs-emscripten with a `std`/`os` shim      |
| local                                | the host's `python3`                          | the host's `python3`                           |
| sandlock                             | host `python3` and `node` under Landlock      | the same                                       |
| docker, ssh, smolvm, apple_container | whole lines in a box the user runs            | the same                                       |
| e2b                                  | whole lines in an E2B sandbox                 | not run here (below)                           |

The e2b variants run on the python host only. E2B's sandbox proxy now and
then closes its connection to envd while a command's output is still
streaming and answers `unavailable ... ended before the stream completed`;
only the JS SDK's traffic trips it, with or without mirage in between, so
the typescript runners leave e2b out of their runtime tables.

## How a case reads

- `runtimes` lists the runtimes a shared case runs on; each becomes the
  variant `<case>@<runtime>`, left out on a host that lacks the runtime.
- A step gives its guest code once per language: `program` (inline, run as
  `python3 -c` or `node -e`), `script` (a file under
  `integ/fixtures/runtime/`, in the folder of the same topic) or `command`
  (a whole line). A step without the runtime's language is left out of that
  variant. A sandbox runs the plain lines.
- `entry` narrows a runtime's captures or adds to its config for one case;
  the runners hold each runtime's base entry (a sandbox's container, host or
  sandbox id comes from the job's environment).
- `expect` is the shared answer, CPython's on Linux. A step whose program
  differs by language may key `expect` by language too, as `program` is:
  `{"python": {...}, "js": {...}}`. `expect_on` overrides it by `runtime`,
  `runtime@host`, `backend` or `runtime@backend`. Every override is a
  recorded difference, named in the folder's README.
- `parallel` holds steps that run at once, each on a session of its own;
  each is checked against its own `expect` once all have ended. A branch
  cannot check the op ledger, which holds every branch's ops.
- `backends` repeats a case over `ram`, `disk`, `ssh`, `s3` and `redis`;
  each mount gets its own key space or directory. `ssh` mounts a fresh
  directory on the ssh runtime's box over SFTP.
- A runtime the hosted runners cannot give every job (e2b, smolvm,
  apple_container, sandlock) is skipped when its requirement is unmet, even
  under `INTEG_RUNTIME_STRICT=1`.

## Running

A suite is named by its path without `.json`; a folder name runs every
suite in it.

```bash
./python/.venv/bin/python integ/runtime/run.py open read/pread
```

```bash
cd integ && pnpm exec tsx runtime/run.ts open read/pread
```

```bash
bash integ/runtime/cli.sh python/.venv/bin/mirage "node typescript/packages/cli/dist/bin/mirage.js" open
```

`INTEG_RUNTIMES=e2b` keeps only the named runtimes' variants; CI's
`integ-e2b` job runs `sandbox` that way.

| Needs                                        | For                                                 |
| -------------------------------------------- | --------------------------------------------------- |
| `MIRAGE_WASI_HOME`                           | wasi                                                |
| `MIRAGE_QUICKJS_HOME`                        | quickjs on the python host                          |
| `S3_ENDPOINT`                                | `s3` variants and `backend/` on the typescript host |
| `REDIS_URL`                                  | `redis` variants and `backend/redis.json`           |
| `MONGODB_URI`                                | `backend/mongodb.json`                              |
| `MIRAGE_INTEG_DOCKER_CONTAINER`              | docker                                              |
| `MIRAGE_INTEG_SSH_HOST`, `_USERNAME`, `_KEY` | ssh, and the `ssh` variants                         |
| `MIRAGE_INTEG_E2B_SANDBOX`                   | e2b                                                 |
| `MIRAGE_INTEG_SMOLVM_MACHINE`                | smolvm                                              |
| `MIRAGE_INTEG_APPLE_CONTAINER`               | apple_container                                     |
| `MIRAGE_INTEG_SANDLOCK`                      | sandlock                                            |

With `INTEG_RUNTIME_STRICT=1` an unmet requirement fails instead of
skipping.
