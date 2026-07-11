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

export interface OCIConfig {
  bucket: string
  namespace: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  endpoint?: string
  timeoutMs?: number
}

export interface OCIConfigRedacted {
  bucket: string
  namespace: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  endpoint: string
  timeoutMs?: number
}

const OCIConfigSchema = z.object({
  bucket: z.string(),
  namespace: z.string(),
  region: z.string(),
  accessKeyId: secretStr(),
  secretAccessKey: secretStr(),
  endpoint: z.string(),
  timeoutMs: z.number().optional(),
})

function resolvedOciEndpoint(config: OCIConfig): string {
  if (config.endpoint !== undefined && config.endpoint !== '') return config.endpoint
  return `https://${config.namespace}.compat.objectstorage.${config.region}.oci.customer-oci.com`
}

export function ociToS3Config(config: OCIConfig): S3Config {
  return {
    bucket: config.bucket,
    region: config.region,
    endpoint: resolvedOciEndpoint(config),
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    forcePathStyle: true,
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
  }
}

export function redactOciConfig(config: OCIConfig): OCIConfigRedacted {
  return redactConfigWithSchema(OCIConfigSchema, {
    ...config,
    endpoint: resolvedOciEndpoint(config),
  }) as unknown as OCIConfigRedacted
}

export function normalizeOciConfig(input: Record<string, unknown>): OCIConfig {
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
  }) as unknown as OCIConfig
}
