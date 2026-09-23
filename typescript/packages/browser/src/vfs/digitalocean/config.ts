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

const DigitalOceanConfigSchema = browserAliasSchema({})

export type DigitalOceanConfig = ConfigOf<typeof DigitalOceanConfigSchema>

export type DigitalOceanConfigRedacted = RedactedConfig<DigitalOceanConfig, 'presignedUrlProvider'>

const alias = makeBrowserS3Alias<DigitalOceanConfig, DigitalOceanConfigRedacted>({
  schema: DigitalOceanConfigSchema,
  endpointFor: derivedEndpoint('region', (region) => `https://${region}.digitaloceanspaces.com`),
})

export const resolvedDigitalOceanEndpoint = alias.resolvedEndpoint
export const digitalOceanToS3Config = alias.toS3Config
export const redactDigitalOceanConfig = alias.redact
export const normalizeDigitalOceanConfig = alias.normalize
