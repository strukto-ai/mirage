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

import {
  parseConfigWithSchema,
  redactConfigWithSchema,
  secretStr,
  z,
} from '@struktoai/mirage-core/resource/secrets'
import type { ConfigOf, RedactedConfig } from '@struktoai/mirage-core/resource/secrets'
import { type FieldNormalizer, secondsToMs } from '@struktoai/mirage-core/utils/normalize'

export const HF_ENDPOINT = 'https://huggingface.co'

export function assertHfRepoId(value: string, field: string): string {
  const parts = value.split('/')
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new Error(`${field} must be in 'namespace/name' form; got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Either spelling the Hub itself accepts for a repository.
 *
 * A repo id is `namespace/name` or a bare `name`, and the second resolves
 * against whoever the token belongs to. That is not a convenience:
 * `hf repo create widget` followed by `hf download widget` is what the real
 * CLI produces, and refusing the bare form made mirage reject an id the Hub
 * had just minted. What is refused is a shape the Hub has no reading for: an
 * empty segment, or more than one slash.
 *
 * A BUCKET keeps the stricter rule (`assertHfRepoId`): the Buckets API has no
 * namespace-from-token step, so a bare bucket name addresses nothing.
 */
export function assertHfRepoRef(value: string, field: string): string {
  const parts = value.split('/')
  if (parts.length > 2 || parts.some((p) => p === '')) {
    throw new Error(`${field} must be 'name' or 'namespace/name'; got ${JSON.stringify(value)}`)
  }
  return value
}

export interface HfBucketsConfig {
  bucket: string
  token?: string
  endpoint?: string
  timeoutMs?: number
  keyPrefix?: string
}

// Python states the timeout in seconds; the redactor fills `endpoint`
// from HF_ENDPOINT, so it is optional on the wire exactly as python's
// default makes it.
const HF_NORMALIZER: FieldNormalizer = {
  rename: { timeout: 'timeoutMs' },
  transform: { timeout: secondsToMs },
}

const HfBucketsConfigSchema = z.object({
  bucket: z.string(),
  token: secretStr().optional(),
  endpoint: z.string().optional(),
  timeoutMs: z.number().optional(),
  keyPrefix: z.string().optional(),
})

// Only the redacted twin derives: the schema is the resolved shape, with
// the endpoint the redactor fills in.
export type HfBucketsConfigRedacted = RedactedConfig<
  ConfigOf<typeof HfBucketsConfigSchema>,
  'token'
>

export function redactHfBucketsConfig(config: HfBucketsConfig): HfBucketsConfigRedacted {
  return redactConfigWithSchema(HfBucketsConfigSchema, {
    ...config,
    endpoint: config.endpoint ?? HF_ENDPOINT,
  }) as unknown as HfBucketsConfigRedacted
}

export function normalizeHfBucketsConfig(input: Record<string, unknown>): HfBucketsConfig {
  const config = parseConfigWithSchema(HfBucketsConfigSchema, input, HF_NORMALIZER)
  assertHfRepoId(config.bucket, 'bucket')
  return config
}

export interface HfRepoConfig {
  repoId: string
  token?: string
  endpoint?: string
  timeoutMs?: number
  keyPrefix?: string
  revision?: string
  // Whether the listing asks the Hub for each path's last commit, which
  // is a Hub file's only source of an mtime and drops the tree page from
  // 1000 rows to 50. Undefined is the default and means decide by size:
  // ask for one expanded page, and keep it if the whole repository fit in
  // it, otherwise re-walk bare. A small repo therefore gets mtimes for the
  // same one request it would have cost without them, and a sharded
  // dataset pays one wasted page rather than a twentyfold walk. true and
  // false force it either way.
  expandCommits?: boolean
}

const HfRepoConfigSchema = z.object({
  repoId: z.string(),
  token: secretStr().optional(),
  endpoint: z.string().optional(),
  timeoutMs: z.number().optional(),
  keyPrefix: z.string().optional(),
  revision: z.string().optional(),
  expandCommits: z.boolean().optional(),
})

// Only the redacted twin derives: the schema is the resolved shape, with
// the endpoint the redactor fills in.
export type HfRepoConfigRedacted = RedactedConfig<ConfigOf<typeof HfRepoConfigSchema>, 'token'>

export function redactHfRepoConfig(config: HfRepoConfig): HfRepoConfigRedacted {
  return redactConfigWithSchema(HfRepoConfigSchema, {
    ...config,
    endpoint: config.endpoint ?? HF_ENDPOINT,
  }) as unknown as HfRepoConfigRedacted
}

export function normalizeHfRepoConfig(input: Record<string, unknown>): HfRepoConfig {
  const config = parseConfigWithSchema(HfRepoConfigSchema, input, HF_NORMALIZER)
  assertHfRepoRef(config.repoId, 'repo_id')
  return config
}
