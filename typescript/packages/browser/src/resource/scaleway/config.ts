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

import { redactConfigWithSchema, secretSchema, z } from '@struktoai/mirage-core'
import type { S3BrowserPresignedUrlProvider, S3Config } from '../s3/config.ts'

export interface ScalewayConfig {
  bucket: string
  presignedUrlProvider: S3BrowserPresignedUrlProvider
  region?: string
  endpoint?: string
  defaultContentType?: string
  keyPrefix?: string
}

export interface ScalewayConfigRedacted extends Omit<ScalewayConfig, 'presignedUrlProvider'> {
  presignedUrlProvider: '<REDACTED>'
}

const ScalewayConfigSchema = z.object({
  bucket: z.string(),
  presignedUrlProvider: secretSchema(
    z.custom<S3BrowserPresignedUrlProvider>((value) => typeof value === 'function'),
  ),
  region: z.string().optional(),
  endpoint: z.string().optional(),
  defaultContentType: z.string().optional(),
  keyPrefix: z.string().optional(),
})

export function resolvedScalewayEndpoint(config: ScalewayConfig): string | undefined {
  if (config.endpoint !== undefined && config.endpoint !== '') return config.endpoint
  if (config.region !== undefined && config.region !== '') {
    const region = config.region
    return `https://s3.${region}.scw.cloud`
  }
  return undefined
}

export function scalewayToS3Config(config: ScalewayConfig): S3Config {
  const endpoint = resolvedScalewayEndpoint(config)
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

export function redactScalewayConfig(config: ScalewayConfig): ScalewayConfigRedacted {
  return redactConfigWithSchema(ScalewayConfigSchema, config) as unknown as ScalewayConfigRedacted
}
