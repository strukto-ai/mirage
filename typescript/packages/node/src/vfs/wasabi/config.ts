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

export type WasabiConfig = S3AliasConfig

export const WasabiConfigSchema = aliasSchema({
  region: z.string().optional().meta({
    description:
      'Wasabi region. It builds the endpoint `https://s3.<region>.wasabisys.com` (`https://s3.wasabisys.com` for `us-east-1`) unless `endpoint` is set, and signs every request.',
    default: 'us-east-1',
  }),
  endpoint: z
    .string()
    .optional()
    .describe('Endpoint URL that replaces the one the provider derives.'),
})

// Only the redacted twin derives; the redactor fills in the region and
// endpoint the provider's rule resolves.
export type WasabiConfigRedacted = RedactedConfig<
  ConfigOf<typeof WasabiConfigSchema>,
  'accessKeyId' | 'secretAccessKey' | 'sessionToken' | 'proxy'
>

export const ALIAS = makeS3Alias<WasabiConfig, WasabiConfigRedacted>({
  schema: WasabiConfigSchema,
  endpointFor: (config) => {
    const region = config.region ?? 'us-east-1'
    return region === 'us-east-1'
      ? 'https://s3.wasabisys.com'
      : `https://s3.${region}.wasabisys.com`
  },
  regionDefault: 'us-east-1',
})

export const resolvedWasabiEndpoint = ALIAS.resolvedEndpoint
export const wasabiToS3Config = ALIAS.toS3Config
