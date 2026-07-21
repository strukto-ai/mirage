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
import type { S3Config } from '../s3/config.ts'

export interface CephConfig {
  bucket: string
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  region?: string
  forcePathStyle?: boolean
  keyPrefix?: string
  timeoutMs?: number
}

export interface CephConfigRedacted {
  bucket: string
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  region: string
  forcePathStyle: boolean
  keyPrefix?: string
  timeoutMs?: number
}

const CephConfigSchema = z.object({
  bucket: z.string(),
  endpoint: z.string(),
  accessKeyId: secretStr(),
  secretAccessKey: secretStr(),
  region: z.string(),
  forcePathStyle: z.boolean(),
  keyPrefix: z.string().optional(),
  timeoutMs: z.number().optional(),
})

export function cephToS3Config(config: CephConfig): S3Config {
  return {
    bucket: config.bucket,
    region: config.region ?? 'us-east-1',
    endpoint: config.endpoint,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    forcePathStyle: config.forcePathStyle ?? true,
    ...(config.keyPrefix !== undefined ? { keyPrefix: config.keyPrefix } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
  }
}

export function redactCephConfig(config: CephConfig): CephConfigRedacted {
  return redactConfigWithSchema(CephConfigSchema, {
    ...config,
    region: config.region ?? 'us-east-1',
    forcePathStyle: config.forcePathStyle ?? true,
  }) as unknown as CephConfigRedacted
}

export function normalizeCephConfig(input: Record<string, unknown>): CephConfig {
  return normalizeFields(input, {
    rename: {
      access_key_id: 'accessKeyId',
      secret_access_key: 'secretAccessKey',
      endpoint_url: 'endpoint',
      path_style: 'forcePathStyle',
      key_prefix: 'keyPrefix',
      timeout: 'timeoutMs',
    },
    transform: {
      timeout: (v: unknown) => (typeof v === 'number' ? v * 1000 : v),
    },
    drop: ['proxy'],
  }) as unknown as CephConfig
}
