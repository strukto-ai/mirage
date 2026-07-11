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

export interface SupabaseConfig {
  bucket: string
  presignedUrlProvider: S3BrowserPresignedUrlProvider
  projectRef?: string
  region?: string
  endpoint?: string
  defaultContentType?: string
}

export interface SupabaseConfigRedacted extends Omit<SupabaseConfig, 'presignedUrlProvider'> {
  presignedUrlProvider: '<REDACTED>'
}

const SupabaseConfigSchema = z.object({
  bucket: z.string(),
  presignedUrlProvider: secretSchema(
    z.custom<S3BrowserPresignedUrlProvider>((value) => typeof value === 'function'),
  ),
  projectRef: z.string().optional(),
  region: z.string().optional(),
  endpoint: z.string().optional(),
  defaultContentType: z.string().optional(),
})

export function resolvedSupabaseEndpoint(config: SupabaseConfig): string | undefined {
  if (config.endpoint !== undefined && config.endpoint !== '') return config.endpoint
  if (config.projectRef !== undefined && config.projectRef !== '') {
    return `https://${config.projectRef}.storage.supabase.co/storage/v1/s3`
  }
  return undefined
}

export function supabaseToS3Config(config: SupabaseConfig): S3Config {
  const endpoint = resolvedSupabaseEndpoint(config)
  return {
    bucket: config.bucket,
    presignedUrlProvider: config.presignedUrlProvider,
    ...(config.region !== undefined ? { region: config.region } : {}),
    ...(endpoint !== undefined ? { endpoint } : {}),
    forcePathStyle: true,
    ...(config.defaultContentType !== undefined
      ? { defaultContentType: config.defaultContentType }
      : {}),
  }
}

export function redactSupabaseConfig(config: SupabaseConfig): SupabaseConfigRedacted {
  return redactConfigWithSchema(SupabaseConfigSchema, config) as unknown as SupabaseConfigRedacted
}
