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

import type { WriteKind } from '../../cache/types.ts'
import { MountMode, WritePolicy } from '../../types.ts'
import type { BaseVFS } from '../../vfs/base.ts'
import { S3VFS } from '../../vfs/s3/s3.ts'
import { WritePolicyError } from './errors.ts'

/**
 * Coerce a declared write-policy name to its `WritePolicy`, or refuse it.
 * Absent (`undefined`, `null`, `''`) means unconditional. Idempotent on a
 * member. Mirrors Python's `coerce_write_policy`.
 *
 * @throws if the value is not a known policy name.
 */
export function coerceWritePolicy(value: unknown): WritePolicy {
  if (value === undefined || value === null || value === '') return WritePolicy.UNCONDITIONAL
  const known = Object.values(WritePolicy) as string[]
  if (typeof value !== 'string') {
    throw new WritePolicyError(
      `unknown write policy ${JSON.stringify(value)}; expected one of: ${known.join(', ')}`,
    )
  }
  const lowered = value.toLowerCase()
  if (!known.includes(lowered)) {
    throw new WritePolicyError(
      `unknown write policy '${value}'; expected one of: ${known.join(', ')}`,
    )
  }
  return lowered as WritePolicy
}

export function writeConditions(vfs: BaseVFS): readonly WriteKind[] {
  return (['put', 'copy', 'delete'] satisfies WriteKind[]).filter((kind) =>
    (vfs.conditionSupport[kind] ?? []).includes('match'),
  )
}

/** The operations this mount's backend can condition on absence. Mirrors Python's `create_conditions`. */
export function createConditions(vfs: BaseVFS): readonly WriteKind[] {
  return (['put', 'copy', 'delete'] satisfies WriteKind[]).filter((kind) =>
    (vfs.conditionSupport[kind] ?? []).includes('absent'),
  )
}

/**
 * Refuse a write policy this mount cannot honour.
 *
 * A policy that cannot act must say so: a conditional mount whose writes would
 * go out unconditioned is the silent downgrade the policy exists to remove, so
 * it is refused at mount time. Mirrors Python's `check_write_capability`.
 *
 * @param caches whether the mount keeps a cached copy (the version a write
 *   sends is the one that copy holds)
 * @throws if the mount cannot honour the declared policy.
 */
export function checkWriteCapability(
  prefix: string,
  vfs: BaseVFS,
  policy: WritePolicy,
  mode: MountMode,
  caches: boolean,
): void {
  if (policy === WritePolicy.STAGED) {
    throw new WritePolicyError(
      `mount '${prefix}': write: staged needs a staging layer, and mirage has none; ` +
        'use conditional or unconditional',
    )
  }
  if (policy !== WritePolicy.CONDITIONAL) return
  if (mode === MountMode.READ) {
    throw new WritePolicyError(
      `mount '${prefix}': write: conditional needs a writable mount; this one is read`,
    )
  }
  if (vfs instanceof S3VFS && vfs.presigned) {
    throw new WritePolicyError(
      `mount '${prefix}': write: conditional cannot be sent through a presigned-URL client, ` +
        'which carries no condition',
    )
  }
  if (writeConditions(vfs).length === 0) {
    throw new WritePolicyError(
      `mount '${prefix}': write: conditional needs a backend that refuses a stale write; ` +
        `${vfs.name} does not`,
    )
  }
  if (!caches) {
    throw new WritePolicyError(
      `mount '${prefix}': write: conditional needs a mount that caches reads; ` +
        'the version a write sends is the one its cached copy holds',
    )
  }
}
