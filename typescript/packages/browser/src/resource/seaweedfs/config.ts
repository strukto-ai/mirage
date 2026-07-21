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

export interface SeaweedFSConfig {
  bucket: string
  presignedUrlProvider: S3BrowserPresignedUrlProvider
  endpoint?: string
  region?: string
  defaultContentType?: string
  keyPrefix?: string
}

export interface SeaweedFSConfigRedacted extends Omit<SeaweedFSConfig, 'presignedUrlProvider'> {
  presignedUrlProvider: '<REDACTED>'
}

const SeaweedFSConfigSchema = z.object({
  bucket: z.string(),
  presignedUrlProvider: secretSchema(
    z.custom<S3BrowserPresignedUrlProvider>((value) => typeof value === 'function'),
  ),
  endpoint: z.string().optional(),
  region: z.string().optional(),
  defaultContentType: z.string().optional(),
  keyPrefix: z.string().optional(),
})

export function seaweedfsToS3Config(config: SeaweedFSConfig): S3Config {
  return {
    bucket: config.bucket,
    presignedUrlProvider: config.presignedUrlProvider,
    ...(config.region !== undefined ? { region: config.region } : {}),
    ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
    ...(config.defaultContentType !== undefined
      ? { defaultContentType: config.defaultContentType }
      : {}),
    ...(config.keyPrefix !== undefined ? { keyPrefix: config.keyPrefix } : {}),
  }
}

export function redactSeaweedFSConfig(config: SeaweedFSConfig): SeaweedFSConfigRedacted {
  return redactConfigWithSchema(SeaweedFSConfigSchema, config) as unknown as SeaweedFSConfigRedacted
}
