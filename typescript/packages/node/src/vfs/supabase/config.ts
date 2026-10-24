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
  z,
} from '@struktoai/mirage-core/vfs/secrets'
import type { ConfigOf, RedactedConfig } from '@struktoai/mirage-core/vfs/secrets'
import { S3_FAMILY_NORMALIZER } from '../s3/config.ts'
import { ALIAS_SHAPE } from '../s3_alias.ts'
import type { S3Config } from '../s3/config.ts'

export interface SupabaseConfig {
  bucket: string
  region: string
  accessKeyId?: string
  secretAccessKey?: string
  projectRef?: string
  endpoint?: string
  sessionToken?: string
  profile?: string
  forcePathStyle?: boolean
  keyPrefix?: string
  timeoutMs?: number
  proxy?: string
  walkLimit?: number
}

const SupabaseConfigSchema = z.object({
  ...ALIAS_SHAPE,
  forcePathStyle: z.boolean().optional().meta({ default: true }),
  region: z
    .string()
    .describe(
      'Provider region every request is signed for. Most providers also build their endpoint URL from it unless `endpoint` is set.',
    ),
  endpoint: z
    .string()
    .optional()
    .describe('Endpoint URL that replaces the one the provider derives.'),
  projectRef: z
    .string()
    .optional()
    .describe(
      'Supabase project reference. It builds the endpoint `https://<projectRef>.storage.supabase.co/storage/v1/s3` unless `endpoint` is set; one of the two is required.',
    ),
})

// Only the redacted twin derives; the redactor fills in the region and
// endpoint the provider's rule resolves.
export type SupabaseConfigRedacted = RedactedConfig<
  ConfigOf<typeof SupabaseConfigSchema>,
  'accessKeyId' | 'secretAccessKey' | 'sessionToken' | 'proxy'
>

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
    ...(config.accessKeyId !== undefined ? { accessKeyId: config.accessKeyId } : {}),
    ...(config.secretAccessKey !== undefined ? { secretAccessKey: config.secretAccessKey } : {}),
    ...(config.sessionToken !== undefined ? { sessionToken: config.sessionToken } : {}),
    ...(config.profile !== undefined ? { profile: config.profile } : {}),
    forcePathStyle: config.forcePathStyle ?? true,
    ...(config.keyPrefix !== undefined ? { keyPrefix: config.keyPrefix } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.proxy !== undefined ? { proxy: config.proxy } : {}),
    ...(config.walkLimit !== undefined ? { walkLimit: config.walkLimit } : {}),
  }
}

export function redactSupabaseConfig(config: SupabaseConfig): SupabaseConfigRedacted {
  return redactConfigWithSchema(SupabaseConfigSchema, {
    ...config,
    endpoint: resolvedSupabaseEndpoint(config),
    forcePathStyle: config.forcePathStyle ?? true,
  }) as unknown as SupabaseConfigRedacted
}

export function normalizeSupabaseConfig(input: Record<string, unknown>): SupabaseConfig {
  return parseConfigWithSchema(SupabaseConfigSchema, input, S3_FAMILY_NORMALIZER)
}
