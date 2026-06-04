# Reversible Writes: future add-ons and non-goals

What comes after the near-term build (`reversible-writes-now.md`). Two parts: future add-ons *inside* Mirage, ordered by value, and the work that is explicitly *not* Mirage's, with each item's real owner.

Companion doc: `reversible-writes-now.md` (build now).

______________________________________________________________________

## 1. Future add-ons inside Mirage (ordered)

Each builds on the staging + subagent-delta substrate from the "now" doc. They are listed in recommended order, which is also roughly decreasing certainty of value. **Constraint: every add-on runs in-process inside the existing Mirage daemon. None introduces a new process** (the reconciliation loop runs inline at push and stops; the outbox drainer is an async task, not a separate worker; Redis, when used, is an existing service you connect to).

### Add-on A — Drift safety (the trust floor). The first thing to add.

Makes `push` safe, not just reversible. Today push flushes best-effort; this detects that the world changed since the agent read, and aborts or re-decides instead of clobbering. Deterministic, no model.

| Task   | Build                                                                                                                                                                                                       |
| :----- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F1** | Tier registry: classify each write *operation* into A (versioned/CAS), B (create/append), C (mutable, unversioned). Conservative default; detect capability drift                                           |
| **F2** | Reconciliation-loop promoter: at push, observe → converge → repeat, bounded, re-decides each pass                                                                                                           |
| **F3** | CAS + fingerprint oracle: `If-Match` for Tier A (S3, Postgres, Redis, GDoc); a read-set fingerprint manufactures a version for Tier C. Also resolves cross-tenant contention for free on versioned backends |
| **F4** | Leases + fencing tokens: a paused loop cannot write into a resource it no longer owns                                                                                                                       |
| **F5** | Idempotency-key manager: retry safety                                                                                                                                                                       |
| **F6** | Dry-run / simulate: extend the existing provision cost-estimate path                                                                                                                                        |
| **F7** | Stale-intent TTL + re-validation: expire and re-check staged writes whose basis has gone stale (frontier gap G1)                                                                                            |

**Why first:** it is the difference between "undo" and "safe." Without it, push can silently overwrite another writer's change. Pure systems engineering, no new dependency.

### Add-on B — SaaS actions (Tier D events). Only if you want the action product.

Lets agents *act* on semantic backends: post a Slack message, send an email, file a Linear ticket. These are one-shot side-effects (re-running re-sends), so they need a different engine. **Gated on a product decision** Mirage has not made: does it write to semantic backends at all? Semantic backends are read-only today, so this also requires giving them a write verb first.

| Task    | Build                                                                                                                                                         |
| :------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **F8**  | Saga + durable outbox + governed drainer (an in-process async task, not a separate worker): buffer the side-effect, drain on delay, reversible while buffered |
| **F9**  | TCC for draft-capable backends: Try (draft) → Confirm (publish) → Cancel (discard)                                                                            |
| **F10** | Pseudo-2PC coordinator for multi-object push: prepare = revalidate all, commit in dependency order, Tier D last                                               |

**Why later:** the core Mirage write story is data backends, which never hit Tier D. This is the enterprise "reversible action layer," a separate bet from "mount anything as a filesystem and write data."

### Add-on C — Semantic reach. The only model-in-the-loop part.

When push detects a conflict, instead of blindly aborting, judge whether the staged write is still valid given the change (the agent wanted to mark a ticket Done because a PR merged; if the PR was reverted, do not push).

| Task    | Build                                                                                                                                      |
| :------ | :----------------------------------------------------------------------------------------------------------------------------------------- |
| **F11** | Premise journal: the agent declares its read-basis, hybrid with the access log Mirage already records                                      |
| **F12** | Semantic adjudicator: a separate, stronger model judges staged-op validity on drift; eval-gated before it ever enters the correctness path |
| **F13** | Confidence-gated escalation: route only the low-confidence / high-magnitude / livelock tail to a human                                     |

**Why last:** it is probabilistic, it depends on drift detection (Add-on A) existing first, and it is the part that needs evaluation discipline before it can be trusted.

### Add-on D — Audit / attestation. Build alongside whenever needed.

| Task    | Build                                                                                                                                                                |
| :------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F14** | Durable, tamper-evident record of what was staged, pushed, aborted, compensated, plus the receipts. Extends Mirage's existing op/version recording (frontier gap G7) |

______________________________________________________________________

## 2. Not Mirage (hand-offs)

Named so nothing here is mistaken for a Mirage task. The gap numbers (G\*) are a separate axis from tiers (A/B/C/D) and tasks.

| Not in Mirage                             | Owner                              | Why it is not the write layer's                                                                                                                                               |
| :---------------------------------------- | :--------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kernel / Rust / effect-kernel             | not needed                         | Staging is pure Python/TS in the write seam plus the cache stores. A kernel is only needed to serve syscalls for a *foreign* sandboxed process, which staging never involves. |
| **G2 — Poisoned premises**                | agent-security / guardrails module | The "is this content malicious" judgment is the model's, not the VFS's. Mirage at most emits a provenance tag on reads for the guardrails module to consume.                  |
| **G3 — Out-of-band effects**              | the sandbox / runtime layer        | Mirage governs writes that flow *through* it; effects from executed code are contained by sandboxing the agent's execution, not by staging.                                   |
| **G4 — Cross-tenant contention**          | absorbed by F3 (CAS), else physics | On versioned backends the conditional write resolves it for free; on Tier C/D no shared authority exists. Not a separate task.                                                |
| **G5 — Rubber-stamp / human bottleneck**  | product / ops                      | A UX and operations concern on the escalation path, not a VFS feature.                                                                                                        |
| **G6 — Long-horizon process consistency** | a workflow engine on top           | Needs a Temporal-shaped resumable orchestrator above push.                                                                                                                    |
| **G8 — Safety-cost modeling**             | future                             | Only exists once the Add-on C adjudicator does.                                                                                                                               |

The only frontier gaps the write layer itself owns are **G1 (stale intents → F7)** and **G7 (audit → F14)**, both already in the add-on list above.

______________________________________________________________________

## 3. The shape of the roadmap, in one line

**Now:** reversible writes + subagent deltas over data backends.
**Then:** drift safety (Add-on A), so push stops being best-effort.
**If the action product is pursued:** SaaS events (Add-on B).
**Eventually:** the semantic reach (Add-on C), the only model-in-the-loop piece.
**Throughout:** audit (Add-on D).
**Never:** the hand-offs in Section 2; they belong to the sandbox / runtime layer, the guardrails module, product, or a workflow engine on top.
