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

export interface OCIConfig extends S3AliasConfig {
  namespace: string
  region: string
}

export const OCIConfigSchema = aliasSchema({
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
  namespace: z
    .string()
    .describe(
      'Object Storage namespace of the tenancy. With `region` it builds the endpoint `https://<namespace>.compat.objectstorage.<region>.oci.customer-oci.com` unless `endpoint` is set.',
    ),
})

// Only the redacted twin derives; the redactor fills in the region and
// endpoint the provider's rule resolves.
export type OCIConfigRedacted = RedactedConfig<
  ConfigOf<typeof OCIConfigSchema>,
  'accessKeyId' | 'secretAccessKey' | 'sessionToken' | 'proxy'
>

export const ALIAS = makeS3Alias<OCIConfig, OCIConfigRedacted>({
  schema: OCIConfigSchema,
  endpointFor: (config) =>
    `https://${config.namespace}.compat.objectstorage.${config.region}.oci.customer-oci.com`,
  forcePathStyle: true,
})

export const ociToS3Config = ALIAS.toS3Config
