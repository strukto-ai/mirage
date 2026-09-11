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

export const GCS_ENDPOINT = 'https://storage.googleapis.com'

export interface GCSConfig {
  bucket: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  profile?: string
  endpoint?: string
  region?: string
  timeoutMs?: number
  forcePathStyle?: boolean
  keyPrefix?: string
  proxy?: string
}

const GCSConfigSchema = z.object({
  bucket: z.string(),
  accessKeyId: secretStr().optional(),
  secretAccessKey: secretStr().optional(),
  sessionToken: secretStr().optional(),
  profile: z.string().optional(),
  endpoint: z.string().optional(),
  region: z.string().optional(),
  timeoutMs: z.number().optional(),
  forcePathStyle: z.boolean().optional(),
  keyPrefix: z.string().optional(),
  proxy: secretStr().optional(),
})

// Only the redacted twin derives; the redactor fills in the region and
// endpoint the provider's rule resolves.
export type GCSConfigRedacted = RedactedConfig<
  ConfigOf<typeof GCSConfigSchema>,
  'accessKeyId' | 'secretAccessKey' | 'sessionToken' | 'proxy'
>

export function gcsToS3Config(config: GCSConfig): S3Config {
  return {
    bucket: config.bucket,
    region: config.region ?? 'auto',
    endpoint: config.endpoint ?? GCS_ENDPOINT,
    ...(config.accessKeyId !== undefined ? { accessKeyId: config.accessKeyId } : {}),
    ...(config.secretAccessKey !== undefined ? { secretAccessKey: config.secretAccessKey } : {}),
    ...(config.sessionToken !== undefined ? { sessionToken: config.sessionToken } : {}),
    ...(config.profile !== undefined ? { profile: config.profile } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.forcePathStyle !== undefined ? { forcePathStyle: config.forcePathStyle } : {}),
    ...(config.keyPrefix !== undefined ? { keyPrefix: config.keyPrefix } : {}),
    ...(config.proxy !== undefined ? { proxy: config.proxy } : {}),
  }
}

export function redactGcsConfig(config: GCSConfig): GCSConfigRedacted {
  return redactConfigWithSchema(GCSConfigSchema, {
    ...config,
    endpoint: config.endpoint ?? GCS_ENDPOINT,
    region: config.region ?? 'auto',
  }) as unknown as GCSConfigRedacted
}

export function normalizeGcsConfig(input: Record<string, unknown>): GCSConfig {
  return parseConfigWithSchema(GCSConfigSchema, input, S3_FAMILY_NORMALIZER)
}
