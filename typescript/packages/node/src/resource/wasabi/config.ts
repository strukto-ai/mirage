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
import { S3_FAMILY_NORMALIZER } from '../s3/config.ts'
import type { S3Config } from '../s3/config.ts'

export interface WasabiConfig {
  bucket: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  profile?: string
  region?: string
  endpoint?: string
  forcePathStyle?: boolean
  keyPrefix?: string
  timeoutMs?: number
  proxy?: string
}

const WasabiConfigSchema = z.object({
  bucket: z.string(),
  accessKeyId: secretStr().optional(),
  secretAccessKey: secretStr().optional(),
  sessionToken: secretStr().optional(),
  profile: z.string().optional(),
  region: z.string().optional(),
  endpoint: z.string().optional(),
  forcePathStyle: z.boolean().optional(),
  keyPrefix: z.string().optional(),
  timeoutMs: z.number().optional(),
  proxy: secretStr().optional(),
})

// Only the redacted twin derives; the redactor fills in the region and
// endpoint the provider's rule resolves.
export type WasabiConfigRedacted = RedactedConfig<
  ConfigOf<typeof WasabiConfigSchema>,
  'accessKeyId' | 'secretAccessKey' | 'sessionToken' | 'proxy'
>

export function resolvedWasabiEndpoint(config: WasabiConfig): string {
  if (config.endpoint !== undefined && config.endpoint !== '') return config.endpoint
  const region = config.region ?? 'us-east-1'
  return region === 'us-east-1' ? 'https://s3.wasabisys.com' : `https://s3.${region}.wasabisys.com`
}

export function wasabiToS3Config(config: WasabiConfig): S3Config {
  return {
    bucket: config.bucket,
    region: config.region ?? 'us-east-1',
    endpoint: resolvedWasabiEndpoint(config),
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

export function redactWasabiConfig(config: WasabiConfig): WasabiConfigRedacted {
  return redactConfigWithSchema(WasabiConfigSchema, {
    ...config,
    region: config.region ?? 'us-east-1',
    endpoint: resolvedWasabiEndpoint(config),
  }) as unknown as WasabiConfigRedacted
}

export function normalizeWasabiConfig(input: Record<string, unknown>): WasabiConfig {
  return parseConfigWithSchema(WasabiConfigSchema, input, S3_FAMILY_NORMALIZER)
}
