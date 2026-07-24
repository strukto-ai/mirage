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

import { z } from 'zod'
import { redactConfigWithSchema, secretSchema, secretStr } from '../secrets.ts'
import * as kp from '../../utils/key_prefix.ts'

export type S3BrowserOperation = 'GET' | 'PUT' | 'HEAD' | 'DELETE' | 'LIST' | 'COPY'

export interface S3BrowserSignOptions {
  contentType?: string
  ttlSec?: number
  listPrefix?: string
  listDelimiter?: string
  listContinuationToken?: string
  copySource?: string
}

export type S3BrowserPresignedUrlProvider = (
  path: string,
  operation: S3BrowserOperation,
  options?: S3BrowserSignOptions,
) => Promise<string>

export const S3ConfigSchema = z.object({
  bucket: z.string(),
  region: z.string().optional(),
  endpoint: z.string().optional(),
  accessKeyId: secretStr().optional(),
  secretAccessKey: secretStr().optional(),
  sessionToken: secretStr().optional(),
  forcePathStyle: z.boolean().optional(),
  timeoutMs: z.number().optional(),
  presignedUrlProvider: secretSchema(
    z.custom<S3BrowserPresignedUrlProvider>((value) => typeof value === 'function'),
  ).optional(),
  defaultContentType: z.string().optional(),
  keyPrefix: z.string().optional(),
})

export interface S3Config {
  bucket: string
  region?: string
  endpoint?: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  forcePathStyle?: boolean
  timeoutMs?: number
  presignedUrlProvider?: S3BrowserPresignedUrlProvider
  defaultContentType?: string
  keyPrefix?: string
}

export function normalizeKeyPrefix(v: string | undefined): string | undefined {
  const out = kp.normalize(v)
  return out === '' ? undefined : out
}

export interface S3ConfigRedacted extends Omit<
  S3Config,
  'accessKeyId' | 'secretAccessKey' | 'sessionToken' | 'presignedUrlProvider'
> {
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  presignedUrlProvider?: '<REDACTED>'
}

export function redactConfig(config: S3Config): S3ConfigRedacted {
  return redactConfigWithSchema(S3ConfigSchema, config) as unknown as S3ConfigRedacted
}
