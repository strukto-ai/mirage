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
import { browserAliasSchema, makeBrowserS3Alias } from '../s3_alias.ts'

const OCIConfigSchema = browserAliasSchema({ namespace: z.string().optional() })

export type OCIConfig = ConfigOf<typeof OCIConfigSchema>

export type OCIConfigRedacted = RedactedConfig<OCIConfig, 'presignedUrlProvider'>

const alias = makeBrowserS3Alias<OCIConfig, OCIConfigRedacted>({
  schema: OCIConfigSchema,
  endpointFor: (config) =>
    config.namespace !== undefined &&
    config.namespace !== '' &&
    config.region !== undefined &&
    config.region !== ''
      ? `https://${config.namespace}.compat.objectstorage.${config.region}.oci.customer-oci.com`
      : undefined,
})

export const resolvedOciEndpoint = alias.resolvedEndpoint
export const ociToS3Config = alias.toS3Config
export const redactOciConfig = alias.redact
export const normalizeOCIConfig = alias.normalize
