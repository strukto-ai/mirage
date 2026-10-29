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

export const GCS_ENDPOINT = 'https://storage.googleapis.com'

export type GCSConfig = S3AliasConfig

export const GCSConfigSchema = aliasSchema({
  region: z.string().optional().meta({
    description: 'Region requests are signed for; GCS serves every region from one host.',
    default: 'auto',
  }),
  endpoint: z.string().optional().meta({
    description: 'Endpoint URL of the S3 interoperability API.',
    default: 'https://storage.googleapis.com',
  }),
})

// Only the redacted twin derives; the redactor fills in the region and
// endpoint the provider's rule resolves.
export type GCSConfigRedacted = RedactedConfig<
  ConfigOf<typeof GCSConfigSchema>,
  'accessKeyId' | 'secretAccessKey' | 'sessionToken' | 'proxy'
>

export const ALIAS = makeS3Alias<GCSConfig, GCSConfigRedacted>({
  schema: GCSConfigSchema,
  endpointFor: (config) => config.endpoint ?? GCS_ENDPOINT,
  regionDefault: 'auto',
})

export const gcsToS3Config = ALIAS.toS3Config
