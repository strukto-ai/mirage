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

import { normalizeFields, redactConfigWithSchema, secretStr, z } from '@struktoai/mirage-core'

export const HF_ENDPOINT = 'https://huggingface.co'

export function assertHfRepoId(value: string, field: string): string {
  const parts = value.split('/')
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new Error(`${field} must be in 'namespace/name' form; got ${JSON.stringify(value)}`)
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

export interface HfBucketsConfigRedacted {
  bucket: string
  token?: string
  endpoint: string
  timeoutMs?: number
  keyPrefix?: string
}

const HfBucketsConfigSchema = z.object({
  bucket: z.string(),
  token: secretStr().optional(),
  endpoint: z.string(),
  timeoutMs: z.number().optional(),
  keyPrefix: z.string().optional(),
})

export function redactHfBucketsConfig(config: HfBucketsConfig): HfBucketsConfigRedacted {
  return redactConfigWithSchema(HfBucketsConfigSchema, {
    ...config,
    endpoint: config.endpoint ?? HF_ENDPOINT,
  }) as unknown as HfBucketsConfigRedacted
}

export function normalizeHfBucketsConfig(input: Record<string, unknown>): HfBucketsConfig {
  const config = normalizeFields(input, {
    rename: {
      key_prefix: 'keyPrefix',
      timeout: 'timeoutMs',
    },
    transform: {
      timeout: (v: unknown) => (typeof v === 'number' ? v * 1000 : v),
    },
  }) as unknown as HfBucketsConfig
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
}

export interface HfRepoConfigRedacted {
  repoId: string
  token?: string
  endpoint: string
  timeoutMs?: number
  keyPrefix?: string
  revision?: string
}

const HfRepoConfigSchema = z.object({
  repoId: z.string(),
  token: secretStr().optional(),
  endpoint: z.string(),
  timeoutMs: z.number().optional(),
  keyPrefix: z.string().optional(),
  revision: z.string().optional(),
})

export function redactHfRepoConfig(config: HfRepoConfig): HfRepoConfigRedacted {
  return redactConfigWithSchema(HfRepoConfigSchema, {
    ...config,
    endpoint: config.endpoint ?? HF_ENDPOINT,
  }) as unknown as HfRepoConfigRedacted
}

export function normalizeHfRepoConfig(input: Record<string, unknown>): HfRepoConfig {
  const config = normalizeFields(input, {
    rename: {
      repo_id: 'repoId',
      key_prefix: 'keyPrefix',
      timeout: 'timeoutMs',
    },
    transform: {
      timeout: (v: unknown) => (typeof v === 'number' ? v * 1000 : v),
    },
  }) as unknown as HfRepoConfig
  assertHfRepoId(config.repoId, 'repo_id')
  return config
}
