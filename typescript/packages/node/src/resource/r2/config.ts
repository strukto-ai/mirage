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
  normalizeFields,
  redactConfigWithSchema,
  type ConfigOf,
  type RedactedConfig,
  secretStr,
  z,
} from '@struktoai/mirage-core'
import type { S3Config } from '../s3/config.ts'

export interface R2Config {
  bucket: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  accountId?: string
  endpoint?: string
  region?: string
  profile?: string
  forcePathStyle?: boolean
  keyPrefix?: string
  timeoutMs?: number
  proxy?: string
}

const R2ConfigSchema = z.object({
  bucket: z.string(),
  accessKeyId: secretStr().optional(),
  secretAccessKey: secretStr().optional(),
  sessionToken: secretStr().optional(),
  accountId: z.string().optional(),
  endpoint: z.string(),
  region: z.string(),
  profile: z.string().optional(),
  forcePathStyle: z.boolean().optional(),
  keyPrefix: z.string().optional(),
  timeoutMs: z.number().optional(),
  proxy: secretStr().optional(),
})

// Only the redacted twin derives: the schema is the resolved shape, with
// the region and endpoint the redactor fills in.
export type R2ConfigRedacted = RedactedConfig<
  ConfigOf<typeof R2ConfigSchema>,
  'accessKeyId' | 'secretAccessKey' | 'sessionToken' | 'proxy'
>

function resolvedR2Endpoint(config: R2Config): string {
  if (config.endpoint !== undefined && config.endpoint !== '') return config.endpoint
  if (config.accountId !== undefined && config.accountId !== '') {
    return `https://${config.accountId}.r2.cloudflarestorage.com`
  }
  throw new Error('R2Config requires accountId or endpoint')
}

export function r2ToS3Config(config: R2Config): S3Config {
  return {
    bucket: config.bucket,
    region: config.region ?? 'auto',
    endpoint: resolvedR2Endpoint(config),
    ...(config.accessKeyId !== undefined ? { accessKeyId: config.accessKeyId } : {}),
    ...(config.secretAccessKey !== undefined ? { secretAccessKey: config.secretAccessKey } : {}),
    ...(config.sessionToken !== undefined ? { sessionToken: config.sessionToken } : {}),
    ...(config.profile !== undefined ? { profile: config.profile } : {}),
    ...(config.forcePathStyle !== undefined ? { forcePathStyle: config.forcePathStyle } : {}),
    ...(config.keyPrefix !== undefined ? { keyPrefix: config.keyPrefix } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.proxy !== undefined ? { proxy: config.proxy } : {}),
  }
}

export function redactR2Config(config: R2Config): R2ConfigRedacted {
  return redactConfigWithSchema(R2ConfigSchema, {
    ...config,
    endpoint: resolvedR2Endpoint(config),
    region: config.region ?? 'auto',
  }) as unknown as R2ConfigRedacted
}

export function normalizeR2Config(input: Record<string, unknown>): R2Config {
  return normalizeFields(input, {
    rename: {
      account_id: 'accountId',
      access_key_id: 'accessKeyId',
      secret_access_key: 'secretAccessKey',
      session_token: 'sessionToken',
      aws_profile: 'profile',
      endpoint_url: 'endpoint',
      path_style: 'forcePathStyle',
      key_prefix: 'keyPrefix',
      timeout: 'timeoutMs',
    },
    transform: {
      timeout: (v: unknown) => (typeof v === 'number' ? v * 1000 : v),
    },
  }) as unknown as R2Config
}
