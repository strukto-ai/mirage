# Design: Staged writes (per-object copy-on-write overlay)

Tracking issue: strukto-ai/mirage#138 (Phase 1)

## 1. Summary

Add an automatic, agent-invisible write overlay to `Workspace`. A write to a
path lands in a per-object delta instead of going straight to the backend. The
agent reads its own writes back (read-your-own-write). The platform decides,
gated by policy or verification, when to `push` the delta to the real backend,
or `restore` (discard) it. The backend is never mutated until `push`.

The unit of account is the object (path). The mount is only a routing
boundary: it tells each staged object which backend its flush targets and what
"publish" means for that backend (raw bytes for S3 or Disk, a message for
Slack, a no-op for a read-only or RAM mount). A mount does not force "flush all
of its objects together".

## 2. Two lanes (and why they stay separate)

There are two independent granularities. They share storage primitives but are
different lanes with different owners and lifecycles.

|                   | Per-object staging (this doc)                           | Whole-workspace versioning (exists)                                   |
| ----------------- | ------------------------------------------------------- | --------------------------------------------------------------------- |
| Unit              | one object / path                                       | the entire workspace                                                  |
| Granularity       | fine, within a run                                      | coarse, run-level checkpoint / fork                                   |
| Driver            | automatic in the write path; push is platform-gated     | explicit operator verbs                                               |
| Verbs             | `diff` / `push` / `restore` (orchestrator API)          | `branch` / `commit` / `checkout` / `log` / `diff` (`server/version/`) |
| Motivation served | rollback (#16.1), no premature side effects (#86)       | Tree-of-Thought isolation (#16), run checkpoints                      |
| Storage           | RAM/Redis delta (this doc), optional version-store tree | git-backed trees in `~/.mirage/repos/<id>`                            |

Staging reuses versioning's *storage and diff machinery*, not its lane. The two
must not be conflated: in the versioning lane `commit` is a safe local
checkpoint, while in the staging lane `push` mutates production. Keeping them
separate avoids that footgun.

### What each lane owns from #138's motivation

- Per-object staging delivers: **rollback** (an aborted run discards the delta,
  backend untouched) and **deferred side effects** (nothing publishes until
  push).
- Whole-workspace versioning delivers: **isolation of a whole run** (the
  Tree-of-Thought case, fork the entire workspace per branch).
- Cross-agent isolation within the staging lane comes from the delta's *scope
  key* (Section 4), not from a branch.

## 3. Where this fits the existing code

There is exactly one chokepoint and an existing read-overlay to copy.

`Workspace.dispatch(op, path, **kwargs)` (`workspace.py:512`) is the single
place every op flows through. It already classifies ops:

```python
_DISPATCH_READ_OPS  = {"read", "read_bytes"}
_DISPATCH_WRITE_OPS = {"write", "write_bytes", "append", "unlink", "create", "truncate"}
```

and `stat` / `readdir` route through it (`workspace.py:575-583`).

The file cache is **already a read overlay**: on a read, `dispatch()` checks
`self._cache.get(path)` and serves it before touching the mount
(`workspace.py:520-538`); on a write it invalidates (`workspace.py:541-542`).
Staging adds the symmetric *write* half of a pattern the code already trusts.

## 4. The delta scope key (the load-bearing decision)

The delta must outlive a single `execute()` call (write in call N, read in call
N+1 must see it) and must isolate concurrent agents. So the delta is keyed, not
global.

Recommendation: key the stage by **`agent_id`** (the run), with an optional
explicit `stage_id` override for cases where one agent wants several parallel
attempts.

- Workspace-global delta would give zero isolation: two agents would read each
  other's pending writes. Rejected.
- Per-`session` would tie the delta to shell context (cwd/env) lifecycle, which
  is the wrong axis (see Section 7). Rejected.
- Per-`agent_id` / per-run isolates agents and matches "one run proposes one
  changeset". Chosen.

## 5. Data model

```python
class Stage:
    stage_id: str
    scope: str                      # agent_id / run id this stage isolates
    upper: FileCacheStore           # RAMFileCacheStore or RedisFileCacheStore, eviction OFF
    tombstones: set[str]            # staged deletes (path -> "gone in this stage")
    base_revisions: dict[str, str]  # per-mount pinned revision, snapshot isolation
```

- `upper` reuses `RAMFileCacheStore` / `RedisFileCacheStore`
  (`cache/file/ram.py`, `cache/file/redis.py`). They are key->bytes stores with
  `get` / `set` / `remove` / `exists` / `clear`, and they inherit the full RAM
  command set from `RAMResource`, so reads against the overlay work for free.
- Eviction and TTL MUST be disabled for a stage. A cache may drop entries under
  memory pressure (`_evict`, `ram.py:147`); for a stage that is silent
  data-loss of a pending write. Configure the store with no `cache_limit`
  trigger, or use the underlying `RAMStore` directly without the LRU cap.
- `tombstones` is the one piece of new state. In a cache, `remove(key)` means
  "forget, ask the backend"; in a stage a delete must mean "do not fall through
  to the backend", which is a distinct state.
- `base_revisions` reuses `Mount.revisions` plus the `revision_for` /
  `with_revisions` / `push_revisions` contextvar machinery in
  `observe/context.py`. On the first read that falls through to a mount, pin
  that mount's revision so the stage sees a stable base for its whole life.

## 6. Binding mechanism (contextvar, mirrors sessions)

Stages bind exactly like sessions do. Add a sibling contextvar next to
`runtime/session_context.py`:

```python
# runtime/stage_context.py
_current_stage: ContextVar["Stage | None"] = ContextVar("mirage_current_stage", default=None)

def set_current_stage(stage): return _current_stage.set(stage)
def reset_current_stage(token): _current_stage.reset(token)
def get_current_stage(): return _current_stage.get()
```

Bind it in `Workspace.execute()` in the same try/finally that already binds the
session (`workspace.py:740-794`):

```python
session_token = set_current_session(effective_session)
stage_token = set_current_stage(self._stage_for(agent_id))  # None when no stage open
try:
    ...
finally:
    reset_current_stage(stage_token)
    reset_current_session(session_token)
```

This is the same precedent as `allowed_mounts`: filesystem policy already rides
the execution context (`assert_mount_allowed` reads the current session,
`session_context.py:42`). The stage answers the sibling question "where do this
context's writes land".

## 7. Relationship to the subshell (do not merge)

`Session` (`session/session.py`) holds shell context only (cwd, env, functions,
`allowed_mounts`) and `Session.fork()` isolates that context for subshells,
background jobs, and `cwd`/`env` overrides. Every fork shares the same mount
tree, so a subshell write hits the same backend today.

Keep these orthogonal:

- `Session.fork()` stays unchanged (shell context isolation).
- The stage is a separate object bound by its own contextvar, never a field on
  the `Session` dataclass.
- Subshells do NOT auto-stage by default. In bash `(rm x)` really deletes `x`;
  silently buffering subshell writes would diverge from POSIX. Staging is opened
  by the platform, not implied by a subshell.

## 8. dispatch() interception

Three insertion points, all inside `dispatch()` (`workspace.py:512`).

### 8.1 Read (before cache and mount)

```python
stage = get_current_stage()
if stage is not None and stage.scopes(path):
    if path.original in stage.tombstones:
        raise FileNotFoundError(path.original)
    staged = await stage.upper.get(path.original)
    if staged is not None:
        return staged, IOResult(reads={path.original: staged})
    # miss: fall through, pinning the base revision for snapshot isolation
    stage.pin_base(self._registry.mount_for(path.original))
```

Falls through to the existing cache + mount path unchanged on a miss.

### 8.2 Write (replace the passthrough when a stage is active)

Today (`workspace.py:540-542`):

```python
result = await mount.execute_op(op, path.original, **kwargs)
if op in _DISPATCH_WRITE_OPS:
    await self._invalidate_after_write(mount, path.original)
```

With a stage active:

```python
if stage is not None and op in _DISPATCH_WRITE_OPS and not _is_readonly(mount):
    return await stage.apply_write(op, path.original, **kwargs)  # set bytes or add tombstone
# else: existing passthrough
```

`apply_write` maps `unlink` to a tombstone, `write`/`append`/`truncate`/`create`
to `upper.set` (append reads current staged-or-lower bytes first). Read-only
mounts (`mount.mode == READ`, or `resource` read-only like Slack/GitHub) are
never staged: the write path is a no-op there exactly as it is today
(`mount.py:488`).

### 8.3 readdir merge

Union the lower listing with `upper` keys under the directory, subtract
tombstones, dedup. Mirror the existing readdir route (`workspace.py:580`).

## 9. Orchestrator API (not agent-facing)

The agent runs plain bash and never calls these. The platform does, after its
verification or policy gate.

```python
stage = ws.stage(agent_id="run-42")        # get-or-create the run's stage

# inspect the proposed changeset
await stage.diff()                          # {"added": [...], "modified": [...], "deleted": [...]}

# publish (gated by the platform)
await stage.push()                          # flush the WHOLE pending set (default)
await stage.push(paths=[PathSpec("/s3/r.txt")])  # flush specific objects

# discard
await stage.restore()                       # drop the whole stage; backend untouched
await stage.restore(paths=[PathSpec("/s3/r.txt")])  # drop specific staged objects
```

### push semantics per backend (mount = routing)

`push` walks the pending set, resolves each path with
`self._registry.mount_for(path)`, and publishes per the backend's effect class
(the #86 taxonomy):

| Backend           | Class                             | What push does                              | What restore does             |
| ----------------- | --------------------------------- | ------------------------------------------- | ----------------------------- |
| S3, Disk, RAM     | A (local / reversible-by-discard) | `execute_op("write" / "unlink")`            | drop staged bytes / tombstone |
| Remote idempotent | B                                 | flush with idempotency key (best-effort)    | drop                          |
| Slack post, email | C (non-idempotent)                | fire-last, after the Class A flush succeeds | never fires                   |

Phase 1 implements Class A fully and leaves the B/C seam (buffer-until-push,
fire-last, never-on-restore) for a later phase.

### Atomicity

The unit of account is the object; there is no cross-object atomicity in Phase

1. Default `push` (whole pending set) is best-effort per object plus an
   idempotency key, so a mid-flush failure can leave a partial publish. This is
   documented, not solved, in Phase 1 (matches the issue's stated scope). A run
   that needs all-or-nothing across N objects should also take a whole-workspace
   version (other lane) as the rollback target.

## 10. Reuse map

| Concern                       | Reuse                                                            | Location                                                        |
| ----------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------- |
| Single intercept point        | `Workspace.dispatch()`                                           | `workspace.py:512`                                              |
| Read-overlay precedent        | file cache check before mount                                    | `workspace.py:520-538`                                          |
| Stage byte store              | `RAMFileCacheStore` / `RedisFileCacheStore` (eviction off)       | `cache/file/ram.py`, `cache/file/redis.py`                      |
| Binding mechanism             | contextvar set/reset in `execute()`                              | `runtime/session_context.py`, `workspace.py:740`                |
| Routing + per-backend publish | `Mount.mount_for` / `execute_op` / `mode` / `resource.is_remote` | `mount/registry.py`, `mount/mount.py`                           |
| Base revision pin             | `Mount.revisions` + `revision_for` / `with_revisions`            | `mount/mount.py`, `observe/context.py`                          |
| Read-only no-op               | `mount.mode == READ` guard                                       | `mount/mount.py:488`                                            |
| diff of a changeset           | tree diff machinery                                              | `server/version/api.py:138` (`status`), `store.diff`            |
| Durable stage (optional)      | snapshot a stage as a version-store tree                         | `to_state_dict`, `snapshot_tree_from_state`, `store.write_tree` |
| Coarse run checkpoint         | versioning lane verbs                                            | `server/version/api.py`, CLI `cli/workspace.py`                 |

### Storage choice for `upper`

- Phase 1 default: RAM (`RAMFileCacheStore`, no eviction). Fast, ephemeral,
  per-run.
- Opt-in: Redis (`RedisFileCacheStore`) for a stage that must survive a daemon
  restart or be shared across processes.
- Later option: persist the stage as a version-store tree
  (`snapshot_tree_from_state` -> `store.write_tree`). This gets `diff` and `log`
  of pending changes for free from `store.diff`, at the cost of writing git
  blobs per staged object. Worth it once stages need durability and history;
  not needed for Phase 1.

## 11. Scope

In:

- Per-object overlay in `dispatch()` for all `_DISPATCH_WRITE_OPS`, plus
  read-your-own-write, `readdir` merge, and tombstones.
- Stage bound per `agent_id` via contextvar; base pinned via `Mount.revisions`.
- Orchestrator API: `ws.stage()`, `stage.diff()`, `stage.push()`,
  `stage.restore()`.
- Works over any mount; no-op on read-only mounts.
- Class A effects only (push flushes, restore discards).

Out (later phases):

- Class B/C effect handling (buffer-until-push, fire-last, never-on-restore).
- Cross-object atomicity on backends without multi-object transactions.
- Cross-agent read-others'-writes (commit log) and pluggable merge.
- Per-path consistency tiers (generalize `ConsistencyPolicy` per mount) and a
  strong CAS tier.

## 12. Open questions

1. Scope key: confirm `agent_id` as the default isolation key, and whether an
   explicit `stage_id` is exposed in Phase 1 or deferred.
1. Default `push` target: whole pending set (proposed) vs require explicit
   paths. Proposed default is whole set, since the platform gate is run-level.
1. Durability default: RAM-only for Phase 1 (proposed), Redis opt-in.
1. Where the orchestrator API lives: a `Stage` object returned by `ws.stage()`
   vs methods on `Workspace`. Proposed: a `Stage` object, to keep the surface
   off `Workspace`.
