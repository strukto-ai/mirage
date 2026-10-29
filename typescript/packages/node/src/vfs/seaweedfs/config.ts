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

import {
  makeS3Alias,
  FIXED_ALIAS_SCHEMA,
  type S3AliasConfig,
  type S3AliasConfigRedacted,
} from '../s3_alias.ts'

export interface SeaweedFSConfig extends S3AliasConfig {
  endpoint: string
}

export type SeaweedFSConfigRedacted = S3AliasConfigRedacted

export const SeaweedFSConfigSchema = FIXED_ALIAS_SCHEMA

export const ALIAS = makeS3Alias<SeaweedFSConfig, SeaweedFSConfigRedacted>({
  schema: SeaweedFSConfigSchema,
  endpointFor: (config) => config.endpoint,
  regionDefault: 'us-east-1',
  forcePathStyle: true,
})

export const seaweedfsToS3Config = ALIAS.toS3Config
