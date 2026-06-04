# Reversible Writes: build now in Mirage

What to implement in Mirage in the near term. The scope is deliberately small: make agent writes **reversible** and **isolated per subagent** over data backends. Drift safety, SaaS actions, and the model-in-the-loop are future work (see `reversible-writes-future.md`).

Companion doc: `reversible-writes-future.md` (future work).

______________________________________________________________________

## 1. The goal for now

Two capabilities, both over data backends (S3, Redis, Postgres, Disk, GDrive files):

1. **Reversible writes.** A write lands in a per-run delta instead of the live backend. The agent reads its own writes. The platform decides when to `push` (flush to the backend) or `restore` (discard). The backend is never touched until push.
1. **Per-subagent isolation + merge.** A parent agent spawns subagents; each stages into its own delta; the deltas merge back into the parent before push. This is the multi-agent data infra (Tree-of-Thought, parallel attempts), and it is deterministic plumbing.

What this is **not** yet (and that is on purpose):

- **Not drift-safe.** `push` flushes best-effort; it does not check whether someone changed the object since the agent read it. Fine for agent-owned or single-tenant data; the trust floor (first future add-on) closes this.
- **No SaaS actions.** No posting to Slack, sending email, or filing tickets. Those are semantic backends, read-only today, and a separate product bet.
- **No model in the loop.** Everything here is deterministic systems code.

______________________________________________________________________

## 2. What it reuses (so the build stays small)

- One shared write seam: `Workspace.dispatch()` and `Ops` both funnel through one post-write hook today (`dispatcher.py:99-107`).
- A read-overlay precedent: `dispatch()` already serves the file cache before the mount (`workspace.py:520-538`).
- The cache stores as the buffer: `RAMFileCacheStore` / `RedisFileCacheStore` (`cache/file/ram.py`, `cache/file/redis.py`).
- `ConsistencyPolicy` (`types.py:70`), which today governs only read freshness and grows a write axis.
- The snapshot machinery for forking workspace state: `to_state_dict` / `from_state` and the copy-on-write cache (`workspace/snapshot/`).

Pure Python (and pure TypeScript for the port). No kernel, no Rust, no new process, no new dependency.

______________________________________________________________________

## 3. Phase 1 — the staging primitive

The write-back overlay. Ships a user-visible capability on its own.

| Task   | Build                                                                                                                              | Grounding                                                   |
| :----- | :--------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------- |
| **N1** | Write axis on `ConsistencyPolicy`: add write-back (vs today's write-through), per mount                                            | `types.py:70`, `dispatcher.py`                              |
| **N2** | `Stage` object + delta store: `{scope, upper, tombstones, base_revisions}`; `upper` = a cache store with eviction off              | `cache/file/ram.py`, `cache/file/redis.py`                  |
| **N3** | Bind the stage via a contextvar set/reset in `execute()`; scope key = `agent_id`                                                   | new `runtime/stage_context.py`, mirror `session_context.py` |
| **N4** | Intercept at the shared write seam (both `dispatch()` and `Ops`): write → upper/tombstone, read → overlay-first, `readdir` → merge | `workspace.py:512`, `fuse/fs.py:199`                        |
| **N5** | Pin `Mount.revisions` on first fall-through read (snapshot isolation within a stage)                                               | `mount/mount.py`, `observe/context.py`                      |
| **N6** | Orchestrator API: `ws.stage()`, `stage.diff()`, `stage.push()`, `stage.restore()` (agent-invisible)                                | new `Stage` surface                                         |
| **N7** | `push` flushes the delta to the backend via existing write ops; `restore` drops it. Returns a receipt. No-op on read-only mounts   | reuse `mount.execute_op`                                    |

**Milestone:** S3 only. Overwrite an existing object and create a new one, `stage → push → restore`, read-your-own-write validated. The buffer is RAM by default; use Redis when the delta must survive a process restart.

______________________________________________________________________

## 4. Phase 2 — subagent delta infra

Multi-agent isolation and merge. This is the **internal boundary** (Mirage owns the base), so it needs no CAS, no model, no external safety. It is close to Phase 1 work: the scope key already isolates per agent.

| Task    | Build                                                                                                                                                              |
| :------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **N8**  | Many stages per workspace, one per subagent, keyed by `agent_id` (extends N2/N3 to hold a map of stages)                                                           |
| **N9**  | Subagent fork: a subagent gets a copy-on-write fork of the parent's view (read cache + the parent stage as its read base), reusing the snapshot COW machinery      |
| **N10** | Internal merge on rejoin: merge a subagent's delta (bytes + tombstones) into the parent's delta. No external I/O at merge                                          |
| **N11** | Conflict policy when two subagents touch the same object: deterministic rule (last-writer, or flag for the platform). Order by the fork DAG (who forked from whom) |

**Milestone:** a parent spawns two subagents that each stage writes to disjoint objects; both merge into the parent cleanly; a third case where they touch the same object resolves by the chosen policy. Still no backend contention: push is the parent's single best-effort flush after merge.

______________________________________________________________________

## 5. Build order and the one caveat

**Order:** N1 to N7 (staging) first and it ships alone; then N8 to N11 (subagent deltas) on top.

**Two axes stay independent:** *when* bytes leave the buffer (write-through vs write-back, N1) is separate from *what publishing costs* on a backend (the tier, a future concern). Do not collapse them.

**Two lanes stay separate:** per-object staging (`diff` / `push` / `restore`, this doc) is a different lane from whole-workspace versioning (`commit` / `branch` / `checkout`, already shipped). `commit` stays a safe local checkpoint; `push` is the only verb that crosses into a backend.

**The caveat, stated plainly:** until the trust floor (the first future add-on) lands, `push` is **reversible but not drift-safe**. It flushes best-effort and does not detect that someone changed the object since the agent read it. Ship "undo" now, "don't clobber others" next. This is an explicit choice, fine for agent-owned and single-tenant data, and the first thing to revisit before pointing agents at heavily shared external objects.
