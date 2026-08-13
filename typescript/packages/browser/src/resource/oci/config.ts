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
  redactConfigWithSchema,
  type ConfigOf,
  type RedactedConfig,
  secretSchema,
  z,
} from '@struktoai/mirage-core'
import type { S3BrowserPresignedUrlProvider, S3Config } from '../s3/config.ts'

const OCIConfigSchema = z.object({
  bucket: z.string(),
  presignedUrlProvider: secretSchema(
    z.custom<S3BrowserPresignedUrlProvider>((value) => typeof value === 'function'),
  ),
  namespace: z.string().optional(),
  region: z.string().optional(),
  endpoint: z.string().optional(),
  defaultContentType: z.string().optional(),
  keyPrefix: z.string().optional(),
})

export type OCIConfig = ConfigOf<typeof OCIConfigSchema>

export type OCIConfigRedacted = RedactedConfig<OCIConfig, 'presignedUrlProvider'>

export function resolvedOciEndpoint(config: OCIConfig): string | undefined {
  if (config.endpoint !== undefined && config.endpoint !== '') return config.endpoint
  if (
    config.namespace !== undefined &&
    config.namespace !== '' &&
    config.region !== undefined &&
    config.region !== ''
  ) {
    return `https://${config.namespace}.compat.objectstorage.${config.region}.oci.customer-oci.com`
  }
  return undefined
}

export function ociToS3Config(config: OCIConfig): S3Config {
  const endpoint = resolvedOciEndpoint(config)
  return {
    bucket: config.bucket,
    presignedUrlProvider: config.presignedUrlProvider,
    ...(config.region !== undefined ? { region: config.region } : {}),
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(config.defaultContentType !== undefined
      ? { defaultContentType: config.defaultContentType }
      : {}),
    ...(config.keyPrefix !== undefined ? { keyPrefix: config.keyPrefix } : {}),
  }
}

export function redactOciConfig(config: OCIConfig): OCIConfigRedacted {
  return redactConfigWithSchema(OCIConfigSchema, config) as unknown as OCIConfigRedacted
}
