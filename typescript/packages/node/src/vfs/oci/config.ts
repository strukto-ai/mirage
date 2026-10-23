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

export interface OCIConfig {
  bucket: string
  namespace: string
  region: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  profile?: string
  endpoint?: string
  forcePathStyle?: boolean
  keyPrefix?: string
  timeoutMs?: number
  proxy?: string
}

const OCIConfigSchema = z.object({
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
  namespace: z
    .string()
    .describe(
      'Object Storage namespace of the tenancy. With `region` it builds the endpoint `https://<namespace>.compat.objectstorage.<region>.oci.customer-oci.com` unless `endpoint` is set.',
    ),
})

// Only the redacted twin derives; the redactor fills in the region and
// endpoint the provider's rule resolves.
export type OCIConfigRedacted = RedactedConfig<
  ConfigOf<typeof OCIConfigSchema>,
  'accessKeyId' | 'secretAccessKey' | 'sessionToken' | 'proxy'
>

function resolvedOciEndpoint(config: OCIConfig): string {
  if (config.endpoint !== undefined && config.endpoint !== '') return config.endpoint
  return `https://${config.namespace}.compat.objectstorage.${config.region}.oci.customer-oci.com`
}

export function ociToS3Config(config: OCIConfig): S3Config {
  return {
    bucket: config.bucket,
    region: config.region,
    endpoint: resolvedOciEndpoint(config),
    ...(config.accessKeyId !== undefined ? { accessKeyId: config.accessKeyId } : {}),
    ...(config.secretAccessKey !== undefined ? { secretAccessKey: config.secretAccessKey } : {}),
    ...(config.sessionToken !== undefined ? { sessionToken: config.sessionToken } : {}),
    ...(config.profile !== undefined ? { profile: config.profile } : {}),
    forcePathStyle: config.forcePathStyle ?? true,
    ...(config.keyPrefix !== undefined ? { keyPrefix: config.keyPrefix } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.proxy !== undefined ? { proxy: config.proxy } : {}),
  }
}

export function redactOciConfig(config: OCIConfig): OCIConfigRedacted {
  return redactConfigWithSchema(OCIConfigSchema, {
    ...config,
    endpoint: resolvedOciEndpoint(config),
    forcePathStyle: config.forcePathStyle ?? true,
  }) as unknown as OCIConfigRedacted
}

export function normalizeOciConfig(input: Record<string, unknown>): OCIConfig {
  return parseConfigWithSchema(OCIConfigSchema, input, S3_FAMILY_NORMALIZER)
}
