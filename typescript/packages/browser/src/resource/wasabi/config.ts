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

export interface WasabiConfig {
  bucket: string
  presignedUrlProvider: S3BrowserPresignedUrlProvider
  region?: string
  endpoint?: string
  defaultContentType?: string
  keyPrefix?: string
}

export interface WasabiConfigRedacted extends Omit<WasabiConfig, 'presignedUrlProvider'> {
  presignedUrlProvider: '<REDACTED>'
}

const WasabiConfigSchema = z.object({
  bucket: z.string(),
  presignedUrlProvider: secretSchema(
    z.custom<S3BrowserPresignedUrlProvider>((value) => typeof value === 'function'),
  ),
  region: z.string().optional(),
  endpoint: z.string().optional(),
  defaultContentType: z.string().optional(),
  keyPrefix: z.string().optional(),
})

export function resolvedWasabiEndpoint(config: WasabiConfig): string {
  if (config.endpoint !== undefined && config.endpoint !== '') return config.endpoint
  const region = config.region ?? 'us-east-1'
  return region === 'us-east-1' ? 'https://s3.wasabisys.com' : `https://s3.${region}.wasabisys.com`
}

export function wasabiToS3Config(config: WasabiConfig): S3Config {
  return {
    bucket: config.bucket,
    presignedUrlProvider: config.presignedUrlProvider,
    ...(config.region !== undefined ? { region: config.region } : {}),
    endpoint: resolvedWasabiEndpoint(config),
    ...(config.defaultContentType !== undefined
      ? { defaultContentType: config.defaultContentType }
      : {}),
    ...(config.keyPrefix !== undefined ? { keyPrefix: config.keyPrefix } : {}),
  }
}

export function redactWasabiConfig(config: WasabiConfig): WasabiConfigRedacted {
  return redactConfigWithSchema(WasabiConfigSchema, config) as unknown as WasabiConfigRedacted
}
