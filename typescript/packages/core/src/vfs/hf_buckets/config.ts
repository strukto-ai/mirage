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

import { TimeoutConfig } from '../../core/api/config.ts'
import { normalizeKeyPrefix } from '../../utils/key_prefix.ts'
import type { ConfigOf, RedactedSchema } from '../secrets.ts'
import { parseConfigWithSchema, redactedConfigDump, secretStr, z } from '../secrets.ts'

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

export const HfBucketsConfig = z.object({
  bucket: z.string().describe('Bucket id in `namespace/name` form.'),
  token: secretStr().optional().describe('Hugging Face access token.'),
  endpoint: z.string().optional().meta({
    description: 'Hub origin requests go to, for a mirror or a self-hosted Hub.',
    default: 'https://huggingface.co',
  }),
  ...TimeoutConfig.shape,
  keyPrefix: z
    .string()
    .transform(normalizeKeyPrefix)
    .optional()
    .describe(
      'Path inside the bucket that becomes the mount root; files outside it are not listed.',
    ),
})

export type HfBucketsConfig = ConfigOf<typeof HfBucketsConfig>

export function redactHfBucketsConfig(
  config: HfBucketsConfig,
): RedactedSchema<typeof HfBucketsConfig> {
  return redactedConfigDump(HfBucketsConfig, {
    ...config,
    endpoint: config.endpoint ?? HF_ENDPOINT,
  })
}

export function normalizeHfBucketsConfig(input: Record<string, unknown>): HfBucketsConfig {
  const config = parseConfigWithSchema(HfBucketsConfig, input)
  if (config.keyPrefix === undefined) delete config.keyPrefix
  assertHfRepoId(config.bucket, 'bucket')
  return config
}

export const HfRepoConfig = z.object({
  repoId: z
    .string()
    .describe(
      "Repository id as `namespace/name`, or a bare `name` that resolves against the token's owner.",
    ),
  token: secretStr()
    .optional()
    .describe(
      'Hugging Face access token; unset sends anonymous requests, which reach public repositories only.',
    ),
  endpoint: z.string().optional().meta({
    description: 'Hub origin requests go to, for a mirror or a self-hosted Hub.',
    default: 'https://huggingface.co',
  }),
  ...TimeoutConfig.shape,
  keyPrefix: z
    .string()
    .transform(normalizeKeyPrefix)
    .optional()
    .describe(
      'Path inside the repository that becomes the mount root; files outside it are not listed.',
    ),
  revision: z
    .string()
    .optional()
    .describe('Branch, tag or commit the mount reads; unset reads `main`.'),
  expandCommits: z
    .boolean()
    .optional()
    .describe(
      "Fetch each file's last commit so listings carry modification times, at 50 entries per request instead of 1000. Unset does so only when the whole repository fits in one page.",
    ),
})

export type HfRepoConfig = ConfigOf<typeof HfRepoConfig>

export function redactHfRepoConfig(config: HfRepoConfig): RedactedSchema<typeof HfRepoConfig> {
  return redactedConfigDump(HfRepoConfig, {
    ...config,
    endpoint: config.endpoint ?? HF_ENDPOINT,
  })
}

export function normalizeHfRepoConfig(input: Record<string, unknown>): HfRepoConfig {
  const config = parseConfigWithSchema(HfRepoConfig, input)
  if (config.keyPrefix === undefined) delete config.keyPrefix
  assertHfRepoRef(config.repoId, 'repo_id')
  return config
}
