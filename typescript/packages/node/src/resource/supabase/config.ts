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

export interface SupabaseConfig {
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  projectRef?: string
  endpoint?: string
  sessionToken?: string
  keyPrefix?: string
  timeoutMs?: number
}

export interface SupabaseConfigRedacted {
  bucket: string
  region: string
  projectRef?: string
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  keyPrefix?: string
  timeoutMs?: number
}

const SupabaseConfigSchema = z.object({
  bucket: z.string(),
  region: z.string(),
  projectRef: z.string().optional(),
  endpoint: z.string(),
  accessKeyId: secretStr(),
  secretAccessKey: secretStr(),
  sessionToken: secretStr().optional(),
  keyPrefix: z.string().optional(),
  timeoutMs: z.number().optional(),
})

export function resolvedSupabaseEndpoint(config: SupabaseConfig): string {
  if (config.endpoint !== undefined && config.endpoint !== '') return config.endpoint
  if (config.projectRef !== undefined && config.projectRef !== '') {
    return `https://${config.projectRef}.storage.supabase.co/storage/v1/s3`
  }
  throw new Error('SupabaseConfig requires projectRef or endpoint')
}

export function supabaseToS3Config(config: SupabaseConfig): S3Config {
  return {
    bucket: config.bucket,
    region: config.region,
    endpoint: resolvedSupabaseEndpoint(config),
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    forcePathStyle: true,
    ...(config.sessionToken !== undefined ? { sessionToken: config.sessionToken } : {}),
    ...(config.keyPrefix !== undefined ? { keyPrefix: config.keyPrefix } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
  }
}

export function redactSupabaseConfig(config: SupabaseConfig): SupabaseConfigRedacted {
  return redactConfigWithSchema(SupabaseConfigSchema, {
    ...config,
    endpoint: resolvedSupabaseEndpoint(config),
  }) as unknown as SupabaseConfigRedacted
}

export function normalizeSupabaseConfig(input: Record<string, unknown>): SupabaseConfig {
  return normalizeFields(input, {
    rename: {
      project_ref: 'projectRef',
      access_key_id: 'accessKeyId',
      secret_access_key: 'secretAccessKey',
      session_token: 'sessionToken',
      endpoint_url: 'endpoint',
      key_prefix: 'keyPrefix',
      timeout: 'timeoutMs',
    },
    transform: {
      timeout: (v: unknown) => (typeof v === 'number' ? v * 1000 : v),
    },
    drop: ['proxy'],
  }) as unknown as SupabaseConfig
}
