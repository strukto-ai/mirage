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

export interface AliyunConfig {
  bucket: string
  presignedUrlProvider: S3BrowserPresignedUrlProvider
  region?: string
  endpoint?: string
  defaultContentType?: string
  keyPrefix?: string
}

export interface AliyunConfigRedacted extends Omit<AliyunConfig, 'presignedUrlProvider'> {
  presignedUrlProvider: '<REDACTED>'
}

const AliyunConfigSchema = z.object({
  bucket: z.string(),
  presignedUrlProvider: secretSchema(
    z.custom<S3BrowserPresignedUrlProvider>((value) => typeof value === 'function'),
  ),
  region: z.string().optional(),
  endpoint: z.string().optional(),
  defaultContentType: z.string().optional(),
  keyPrefix: z.string().optional(),
})

export function resolvedAliyunEndpoint(config: AliyunConfig): string | undefined {
  if (config.endpoint !== undefined && config.endpoint !== '') return config.endpoint
  if (config.region !== undefined && config.region !== '') {
    const region = config.region
    return `https://s3.oss-${region}.aliyuncs.com`
  }
  return undefined
}

export function aliyunToS3Config(config: AliyunConfig): S3Config {
  const endpoint = resolvedAliyunEndpoint(config)
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

export function redactAliyunConfig(config: AliyunConfig): AliyunConfigRedacted {
  return redactConfigWithSchema(AliyunConfigSchema, config) as unknown as AliyunConfigRedacted
}
