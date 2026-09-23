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
import { browserAliasSchema, derivedEndpoint, makeBrowserS3Alias } from '../s3_alias.ts'

const R2ConfigSchema = browserAliasSchema({ accountId: z.string().optional() })

export type R2Config = ConfigOf<typeof R2ConfigSchema>

export type R2ConfigRedacted = RedactedConfig<R2Config, 'presignedUrlProvider'>

const alias = makeBrowserS3Alias<R2Config, R2ConfigRedacted>({
  schema: R2ConfigSchema,
  endpointFor: derivedEndpoint(
    'accountId',
    (accountId) => `https://${accountId}.r2.cloudflarestorage.com`,
  ),
  regionDefault: 'auto',
})

export const resolvedR2Endpoint = alias.resolvedEndpoint
export const r2ToS3Config = alias.toS3Config
export const redactR2Config = alias.redact
export const normalizeR2Config = alias.normalize
