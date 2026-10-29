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

import { z } from '@struktoai/mirage-core/vfs/secrets'
import type { ConfigOf, RedactedConfig } from '@struktoai/mirage-core/vfs/secrets'
import { aliasSchema, makeS3Alias, type S3AliasConfig } from '../s3_alias.ts'

export interface R2Config extends S3AliasConfig {
  accountId?: string
}

export const R2ConfigSchema = aliasSchema({
  region: z.string().optional().meta({
    description: 'Region requests are signed for; R2 addresses a bucket by account, not by region.',
    default: 'auto',
  }),
  endpoint: z
    .string()
    .optional()
    .describe('Endpoint URL that replaces the one the provider derives.'),
  accountId: z
    .string()
    .optional()
    .describe(
      'Cloudflare account ID. It builds the endpoint `https://<accountId>.r2.cloudflarestorage.com` unless `endpoint` is set; one of the two is required.',
    ),
})

// Only the redacted twin derives; the redactor fills in the region and
// endpoint the provider's rule resolves.
export type R2ConfigRedacted = RedactedConfig<
  ConfigOf<typeof R2ConfigSchema>,
  'accessKeyId' | 'secretAccessKey' | 'sessionToken' | 'proxy'
>

export const ALIAS = makeS3Alias<R2Config, R2ConfigRedacted>({
  schema: R2ConfigSchema,
  endpointFor: (config) => {
    if (config.accountId !== undefined && config.accountId !== '') {
      return `https://${config.accountId}.r2.cloudflarestorage.com`
    }
    throw new Error('R2Config requires accountId or endpoint')
  },
  regionDefault: 'auto',
})

export const r2ToS3Config = ALIAS.toS3Config
