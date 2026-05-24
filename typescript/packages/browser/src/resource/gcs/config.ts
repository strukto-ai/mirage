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

export interface GCSConfig {
  bucket: string
  presignedUrlProvider: S3BrowserPresignedUrlProvider
  region?: string
  endpoint?: string
  defaultContentType?: string
}

export interface GCSConfigRedacted extends Omit<GCSConfig, 'presignedUrlProvider'> {
  presignedUrlProvider: '<REDACTED>'
}

export const GCSConfigSchema = z.object({
  bucket: z.string(),
  presignedUrlProvider: secretSchema(
    z.custom<S3BrowserPresignedUrlProvider>((value) => typeof value === 'function'),
  ),
  region: z.string().optional(),
  endpoint: z.string().optional(),
  defaultContentType: z.string().optional(),
})

export function gcsToS3Config(config: GCSConfig): S3Config {
  return {
    bucket: config.bucket,
    presignedUrlProvider: config.presignedUrlProvider,
    ...(config.region !== undefined ? { region: config.region } : { region: 'auto' }),
    ...(config.endpoint !== undefined
      ? { endpoint: config.endpoint }
      : { endpoint: 'https://storage.googleapis.com' }),
    ...(config.defaultContentType !== undefined
      ? { defaultContentType: config.defaultContentType }
      : {}),
  }
}

export function redactGcsConfig(config: GCSConfig): GCSConfigRedacted {
  return redactConfigWithSchema(GCSConfigSchema, config) as unknown as GCSConfigRedacted
}
