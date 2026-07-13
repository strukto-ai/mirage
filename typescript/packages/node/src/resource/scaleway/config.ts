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

export interface ScalewayConfig {
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  region: string
  endpoint?: string
  timeoutMs?: number
}

export interface ScalewayConfigRedacted {
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  region: string
  endpoint: string
  timeoutMs?: number
}

const ScalewayConfigSchema = z.object({
  bucket: z.string(),
  accessKeyId: secretStr(),
  secretAccessKey: secretStr(),
  region: z.string(),
  endpoint: z.string(),
  timeoutMs: z.number().optional(),
})

export function resolvedScalewayEndpoint(config: ScalewayConfig): string {
  if (config.endpoint !== undefined && config.endpoint !== '') return config.endpoint
  const region = config.region
  return `https://s3.${region}.scw.cloud`
}

export function scalewayToS3Config(config: ScalewayConfig): S3Config {
  return {
    bucket: config.bucket,
    region: config.region,
    endpoint: resolvedScalewayEndpoint(config),
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
  }
}

export function redactScalewayConfig(config: ScalewayConfig): ScalewayConfigRedacted {
  return redactConfigWithSchema(ScalewayConfigSchema, {
    ...config,
    endpoint: resolvedScalewayEndpoint(config),
  }) as unknown as ScalewayConfigRedacted
}

export function normalizeScalewayConfig(input: Record<string, unknown>): ScalewayConfig {
  return normalizeFields(input, {
    rename: {
      access_key_id: 'accessKeyId',
      secret_access_key: 'secretAccessKey',
      endpoint_url: 'endpoint',
      timeout: 'timeoutMs',
    },
    transform: {
      timeout: (v: unknown) => (typeof v === 'number' ? v * 1000 : v),
    },
    drop: ['proxy'],
  }) as unknown as ScalewayConfig
}
