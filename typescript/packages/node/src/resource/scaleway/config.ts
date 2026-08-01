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

import { makeRegionAlias, type S3AliasConfig, type S3AliasConfigRedacted } from '../s3_alias.ts'

export interface ScalewayConfig extends S3AliasConfig {
  region: string
}

export type ScalewayConfigRedacted = S3AliasConfigRedacted

const alias = makeRegionAlias<ScalewayConfig, ScalewayConfigRedacted>(
  (config) => `https://s3.${config.region}.scw.cloud`,
)

export const resolvedScalewayEndpoint = alias.resolvedEndpoint
export const scalewayToS3Config = alias.toS3Config
export const redactScalewayConfig = alias.redact
export const normalizeScalewayConfig = alias.normalize
