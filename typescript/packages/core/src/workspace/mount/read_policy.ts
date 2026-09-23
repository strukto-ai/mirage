// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { DEFAULT_READ_TTL, ReadPolicy, type ReadSpec } from '../../types.ts'
import { cachesReads, readRevalidatable, type VFS } from '../../vfs/base.ts'

/**
 * Coerce a declared read policy and bound into a ReadSpec.
 *
 * Coercion only: an unknown name is refused here, but whether the resolved
 * policy is one this mount's backend can honour is `checkReadCapability`'s
 * question. The two are split the way Python's `fuse/backend.py` splits
 * `resolve_backend` from `require_kernel_backend`, so the config door and the
 * mount door each run exactly one of them and a refusal is computed once.
 *
 * Missing means bounded at the default bound, everywhere: an absent `read:`
 * in YAML, `undefined` here, and the `Mount` options default all resolve to
 * the same thing.
 *
 * @throws if the policy name is not a known one, or the bound is not a
 *   positive whole number of seconds.
 */
/**
 * Coerce one declared policy name to its `ReadPolicy`, or refuse it.
 *
 * Split out so the mount door can run it on a spec that never passed
 * through `resolveReadSpec`: `ReadPolicy` is a plain string-const object, so
 * a runtime `ReadSpec` carrying `'FRESH'` or `'banana'` matches no `===` in
 * the verdict and would mount and then read as `bounded` everywhere. Absent
 * (`undefined`, `null`, `''`) means bounded, which is what YAML's bare
 * `read:` parses as. Idempotent on a member. Mirrors Python's
 * `coerce_read_policy`.
 *
 * @throws if the value is not a known policy name.
 */
export function coerceReadPolicy(value: unknown): ReadPolicy {
  if (value === undefined || value === null || value === '') return ReadPolicy.BOUNDED
  if (typeof value !== 'string') {
    throw new Error(`unknown read policy ${JSON.stringify(value)}; expected a policy name`)
  }
  const lowered = value.toLowerCase()
  const known = Object.values(ReadPolicy) as string[]
  if (!known.includes(lowered)) {
    throw new Error(`unknown read policy '${value}'; expected one of: ${known.join(', ')}`)
  }
  return lowered as ReadPolicy
}

export function resolveReadSpec(policy: unknown, ttl: unknown): ReadSpec {
  // Policy first, bound second; the Python twin matches, or one document
  // wrong in both ways yields two different refusals across the hosts.
  const resolved = coerceReadPolicy(policy)
  const bound = ttl ?? DEFAULT_READ_TTL
  // A non-positive bound is not a very short one: the store marks such an
  // entry expired the moment it is written (redis EXPIRE <= 0 deletes the
  // key outright), so the mount silently caches nothing. Refusing it is
  // the other half of the rule that refuses `bounded` with no bound.
  if (typeof bound !== 'number' || !Number.isInteger(bound)) {
    throw new Error(`ttl must be whole seconds, got ${JSON.stringify(ttl)}`)
  }
  if (bound < 1) {
    throw new Error(`ttl must be at least 1 second, got ${String(bound)}`)
  }
  return { policy: resolved, ttl: bound }
}

/**
 * Refuse a read policy this mount's backend cannot honour.
 *
 * The rules are ordered, and the order is the answer to two questions that
 * collide on a disk mount: whether the gate can fire at all, and whether the
 * token behind it is worth comparing. A backend that does not cache reads is
 * answered by the first and never reaches the second.
 *
 * A policy that cannot act must say so. Degrading `fresh` to `bounded` on a
 * backend that cannot revalidate is the silent downgrade this whole policy
 * exists to remove, so it is a refusal at mount time rather than a warning at
 * read time.
 *
 * @throws if the backend cannot honour the declared policy.
 */
export function checkReadCapability(prefix: string, vfs: VFS, spec: ReadSpec): void {
  // Coerced, not compared raw. `ReadPolicy` is a string-const object, so a
  // runtime `ReadSpec` carrying `'FRESH'` or `'banana'` -- what an untyped
  // caller reaches the programmatic door with -- matches neither `===`
  // below and the whole verdict silently no-ops. `MountEntry` stores the
  // coerced spec for the same reason. Python coerces at both points too.
  const policy = coerceReadPolicy(spec.policy)
  // Before the policy dispatch, because a bound has to be usable whatever
  // the policy is. `resolveReadSpec` refuses a bad one at the YAML and
  // snapshot doors, but a `ReadSpec` handed straight to `Workspace` or
  // `addMount` never passes through it, and a mount taking ttl=0 accepts
  // every write and keeps nothing: RAM marks the entry expired as it is
  // written and redis deletes the key outright, so the mount silently
  // caches nothing at all.
  if (!Number.isInteger(spec.ttl)) {
    throw new Error(
      `mount '${prefix}': read: ttl must be whole seconds, got ${JSON.stringify(spec.ttl)}`,
    )
  }
  if (spec.ttl < 1) {
    throw new Error(
      `mount '${prefix}': read: ttl must be at least 1 second, got ${String(spec.ttl)}`,
    )
  }
  if (policy === ReadPolicy.PINNED) {
    throw new Error(
      `mount '${prefix}': read: pinned needs a version layer to pin to, and ` +
        'mirage has none; use fresh or bounded',
    )
  }
  if (policy !== ReadPolicy.FRESH) return
  if (!cachesReads(vfs)) {
    throw new Error(
      `mount '${prefix}': read: fresh needs a resource that caches reads; ` +
        `${vfs.kind} does not, so the freshness check could never run`,
    )
  }
  if (!readRevalidatable(vfs)) {
    throw new Error(
      `mount '${prefix}': read: fresh needs a resource that stamps a ` +
        `comparable content token on reads; ${vfs.kind} does not`,
    )
  }
}
