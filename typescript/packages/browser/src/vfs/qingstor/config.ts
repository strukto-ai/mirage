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

import type { ConfigOf, RedactedConfig } from '@struktoai/mirage-core/vfs/secrets'
import { browserAliasSchema, derivedEndpoint, makeBrowserS3Alias } from '../s3_alias.ts'

const QingStorConfigSchema = browserAliasSchema({})

export type QingStorConfig = ConfigOf<typeof QingStorConfigSchema>

export type QingStorConfigRedacted = RedactedConfig<QingStorConfig, 'presignedUrlProvider'>

const alias = makeBrowserS3Alias<QingStorConfig, QingStorConfigRedacted>({
  schema: QingStorConfigSchema,
  endpointFor: derivedEndpoint('region', (region) => `https://s3.${region}.qingstor.com`),
})

export const resolvedQingStorEndpoint = alias.resolvedEndpoint
export const qingStorToS3Config = alias.toS3Config
export const redactQingStorConfig = alias.redact
export const normalizeQingStorConfig = alias.normalize
