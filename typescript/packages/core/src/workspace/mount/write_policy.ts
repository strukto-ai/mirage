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

import { MountMode, WritePolicy } from '../../types.ts'
import type { BaseVFS } from '../../vfs/base.ts'

const ALL: readonly string[] = Object.freeze(['put', 'copy', 'delete'])

/** The ops each backend conditions (docs/home/yaml.mdx, conditions.json). */
export const WRITE_CONDITIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  s3: ALL,
  seaweedfs: ALL,
  minio: Object.freeze(['put']),
  aliyun: ALL,
  backblaze: ALL,
  ceph: ALL,
  digitalocean: ALL,
  gcs: ALL,
  oci: ALL,
  qingstor: ALL,
  r2: ALL,
  scaleway: ALL,
  supabase: ALL,
  tencent: ALL,
  wasabi: ALL,
})

/** A custom `type: s3` endpoint may be MinIO, so it gets MinIO's row. */
export const CUSTOM_ENDPOINT_CONDITIONS: readonly string[] = WRITE_CONDITIONS.minio ?? []

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
    throw new Error(
      `unknown write policy ${JSON.stringify(value)}; expected one of: ${known.join(', ')}`,
    )
  }
  const lowered = value.toLowerCase()
  if (!known.includes(lowered)) {
    throw new Error(`unknown write policy '${value}'; expected one of: ${known.join(', ')}`)
  }
  return lowered as WritePolicy
}

/** The domains AWS serves S3 from: the commercial partitions and China. */
const AWS_DOMAINS = ['amazonaws.com', 'amazonaws.com.cn']

function awsEndpoint(endpoint: string): boolean {
  let host: string
  try {
    host = new URL(endpoint).hostname
  } catch (err) {
    // Not a URL the client could reach AWS at, so it gets the narrower row.
    console.debug(`endpoint not parsed: ${endpoint}: ${String(err)}`)
    return false
  }
  return AWS_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

interface S3ShapedConfig {
  endpoint?: string
  presignedUrlProvider?: unknown
}

function s3Config(vfs: BaseVFS): S3ShapedConfig | undefined {
  return (vfs as unknown as { config?: S3ShapedConfig }).config
}

function resolvedEndpoint(vfs: BaseVFS): string | undefined {
  return (
    (vfs as unknown as { resolvedEndpoint?: string }).resolvedEndpoint ?? s3Config(vfs)?.endpoint
  )
}

function presigned(vfs: BaseVFS): boolean {
  return (
    WRITE_CONDITIONS[vfs.name] !== undefined && s3Config(vfs)?.presignedUrlProvider !== undefined
  )
}

/**
 * The operations whose writes this mount's backend can condition. A
 * presigned-URL config (the browser's fetch client) carries no condition at
 * all, so it has none.
 */
export function writeConditions(vfs: BaseVFS): readonly string[] {
  if (presigned(vfs)) return []
  const conditions = WRITE_CONDITIONS[vfs.name] ?? []
  if (vfs.name !== 's3') return conditions
  const endpoint = resolvedEndpoint(vfs)
  if (endpoint !== undefined && endpoint !== '' && !awsEndpoint(endpoint)) {
    return CUSTOM_ENDPOINT_CONDITIONS
  }
  return conditions
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
  declared: WritePolicy,
  mode: MountMode,
  caches: boolean,
): void {
  const policy = coerceWritePolicy(declared)
  if (policy === WritePolicy.STAGED) {
    throw new Error(
      `mount '${prefix}': write: staged needs a staging layer, and mirage has none; ` +
        'use conditional or unconditional',
    )
  }
  if (policy !== WritePolicy.CONDITIONAL) return
  if (mode === MountMode.READ) {
    throw new Error(
      `mount '${prefix}': write: conditional needs a writable mount; this one is read`,
    )
  }
  if (presigned(vfs)) {
    throw new Error(
      `mount '${prefix}': write: conditional cannot be sent through a presigned-URL client, ` +
        'which carries no condition',
    )
  }
  if (writeConditions(vfs).length === 0) {
    throw new Error(
      `mount '${prefix}': write: conditional needs a backend that refuses a stale write; ` +
        `${vfs.name} does not`,
    )
  }
  if (!caches) {
    throw new Error(
      `mount '${prefix}': write: conditional needs a mount that caches reads; ` +
        'the version a write sends is the one its cached copy holds',
    )
  }
}
