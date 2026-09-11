# integ

Cross-host integration tests: one declarative case corpus runs on the python
host and the typescript host against the same targets, so the two
implementations cannot drift apart.

## Pieces

- `runners/`: the battery. Every case is a shell line executed in a mirage
  workspace against a target's mounts; exit code, stdout and stderr are
  compared across hosts and against pinned goldens.
- `targets.json`: the targets, their mounts, and the env vars each service
  needs.
- `server/`: the fake services. The kit fakes (github, slack, box, dropbox,
  onedrive, gws, mail, gcs, ...) store per run in SQLite through `server/kit/`;
  `server/launcher/main.ts` hosts all of them in one process, one pinned port
  each from `ci/fakes.json`, and announces one `NAME_URL=...` line per arm.
  Each fake has a selftest: `pnpm run <name>:selftest`.
- `prisma/`: one schema per kit fake.
- `fixtures/`: the seed data cases assume.
- `snapshot/`: the cross-language snapshot battery (below). Its own
  corpus, its own two runners, driven by `snapshot/cross.sh`.

## Runs and tenants

A run is an isolated world; a tenant is an account inside it. The runner mints
a fresh run id per target, so parallel batteries against one launcher never
collide.

- HTTP fakes carry the run as a `/_run/<id>/` path prefix, stripped before
  routing; the tenant comes from the credential.
- The mail fake speaks IMAP and SMTP, where no path exists: the username's
  local part is the tenant and the password is the run, so two runs log in at
  one address and see different mail.
- Kit storage is one SQLite file per run under a per-process temp root;
  `POST /reset` seeds or recreates one run.

Stores the fakes do not own are namespaced per run by the runner's adapters
and torn down after: S3 buckets `mirage-integ-<run>-...` (moto in-process by
default), a Mongo database `mirage_integ_<run>`, redis key prefixes, and temp
dirs for ssh.

## Running locally

```bash
cd integ && npx tsx server/launcher/main.ts --config ci/fakes.json
# export the NAME_URL lines it prints, then:
./python/.venv/bin/python integ/runners/python/main.py --facet core --strict \
  --allow-skip chroma,lancedb,nextcloud,notion,postgres,qdrant
```

The core facet also needs redis and mongo on their default ports (CI uses a
`mongo:8` service container; `docker run -d -p 27017:27017 mongo:8` matches
it) and `MIRAGE_QUICKJS_HOME` pointing at the quickjs-ng WASI build for the
scripted target. If a pinned port is taken locally, copy `ci/fakes.json` and
move that one entry.

## Cross-language snapshots

`snapshot/` asks one question the shell-line battery cannot: **can the other
language read what this one wrote?** A snapshot is the workspace document plus
the workspace state, and `lifecycle/` only ever takes one back into the host
that wrote it. `snapshot/cross.sh` runs all four directions -- python to
typescript, typescript to python, and each language to itself as the control.

Each arm builds its **own** world from the same case document, which is what
makes the question answerable without sharing a fake tenant between two
processes. That works because a snapshot carries content for the resources
that hold it (RAM and redis restore through `load_state`) and a fingerprint
for the ones that do not, so an object store the reader seeded from the same
fixture matches by construction, and a live-only mount (slack, gmail, email) is
read live.

**The comparison is the assertion.** Every arm records what its verify steps
observed and `cross.sh` diffs the writer's record against the reader's, so a
plane one language carries and the other drops shows up without anyone having
written an expectation for it. A case's own `expect` blocks pin the absolute
truths a matching pair of wrong answers would otherwise hide.

The planes it covers, per case: the named profile a session ran under and its
policy program, hides and shows and hidden variables, ask rules and the answers
a host gave them, per-mount caps, allow and deny lists, the env template,
coded policy names, installed CLIs with their configs redacted (git, gh,
himalaya, slack, gws), a script CLI's whole program, and the mounts themselves
over ram, redis, s3, slack, gmail, google drive, email and github.

```bash
integ/snapshot/cross.sh                 # skips a case whose service is absent
integ/snapshot/cross.sh --strict        # what CI runs: a skip is a failure
integ/snapshot/cross.sh --case ram_document_sessions_and_asks
```

One arm at a time, which is what to reach for when a direction disagrees:

```bash
./python/.venv/bin/python integ/snapshot/run.py write RUN /tmp/w
cd integ && node_modules/.bin/tsx snapshot/run.ts read RUN /tmp/w --out /tmp/r
diff /tmp/w/<case>.python.json /tmp/r/<case>.typescript.json
```

Two things a case has to say per host rather than once, because they are
deployment wiring a snapshot deliberately does not carry: the runtime a policy
or a script CLI names (python's default world carries monty, typescript's
carries pyodide), and the coded policy classes the loader registers. A case
declares both per language and the reader passes them through the loader's
`profiles=`, `runtimes=` and `policies=`, which is the documented escape hatch.
