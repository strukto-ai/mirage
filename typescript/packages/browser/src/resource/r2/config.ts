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

export interface R2Config {
  bucket: string
  presignedUrlProvider: S3BrowserPresignedUrlProvider
  accountId?: string
  region?: string
  endpoint?: string
  defaultContentType?: string
  keyPrefix?: string
}

export interface R2ConfigRedacted extends Omit<R2Config, 'presignedUrlProvider'> {
  presignedUrlProvider: '<REDACTED>'
}

const R2ConfigSchema = z.object({
  bucket: z.string(),
  presignedUrlProvider: secretSchema(
    z.custom<S3BrowserPresignedUrlProvider>((value) => typeof value === 'function'),
  ),
  accountId: z.string().optional(),
  region: z.string().optional(),
  endpoint: z.string().optional(),
  defaultContentType: z.string().optional(),
  keyPrefix: z.string().optional(),
})

export function resolvedR2Endpoint(config: R2Config): string | undefined {
  if (config.endpoint !== undefined && config.endpoint !== '') return config.endpoint
  if (config.accountId !== undefined && config.accountId !== '') {
    return `https://${config.accountId}.r2.cloudflarestorage.com`
  }
  return undefined
}

export function r2ToS3Config(config: R2Config): S3Config {
  const endpoint = resolvedR2Endpoint(config)
  return {
    bucket: config.bucket,
    presignedUrlProvider: config.presignedUrlProvider,
    region: config.region ?? 'auto',
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(config.defaultContentType !== undefined
      ? { defaultContentType: config.defaultContentType }
      : {}),
    ...(config.keyPrefix !== undefined ? { keyPrefix: config.keyPrefix } : {}),
  }
}

export function redactR2Config(config: R2Config): R2ConfigRedacted {
  return redactConfigWithSchema(R2ConfigSchema, config) as unknown as R2ConfigRedacted
}
