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

export interface SupabaseConfig extends S3AliasConfig {
  region: string
  projectRef?: string
}

export const SupabaseConfigSchema = aliasSchema({
  forcePathStyle: z.boolean().optional().meta({ default: true }),
  region: z
    .string()
    .describe(
      'Provider region every request is signed for. Most providers also build their endpoint URL from it unless `endpoint` is set.',
    ),
  endpoint: z
    .string()
    .optional()
    .describe('Endpoint URL that replaces the one the provider derives.'),
  projectRef: z
    .string()
    .optional()
    .describe(
      'Supabase project reference. It builds the endpoint `https://<projectRef>.storage.supabase.co/storage/v1/s3` unless `endpoint` is set; one of the two is required.',
    ),
})

// Only the redacted twin derives; the redactor fills in the region and
// endpoint the provider's rule resolves.
export type SupabaseConfigRedacted = RedactedConfig<
  ConfigOf<typeof SupabaseConfigSchema>,
  'accessKeyId' | 'secretAccessKey' | 'sessionToken' | 'proxy'
>

export const ALIAS = makeS3Alias<SupabaseConfig, SupabaseConfigRedacted>({
  schema: SupabaseConfigSchema,
  endpointFor: (config) => {
    if (config.projectRef !== undefined && config.projectRef !== '') {
      return `https://${config.projectRef}.storage.supabase.co/storage/v1/s3`
    }
    throw new Error('SupabaseConfig requires projectRef or endpoint')
  },
  forcePathStyle: true,
})

export const resolvedSupabaseEndpoint = ALIAS.resolvedEndpoint
export const supabaseToS3Config = ALIAS.toS3Config
