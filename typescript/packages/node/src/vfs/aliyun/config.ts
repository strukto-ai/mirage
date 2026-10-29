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
  REGION_ALIAS_SCHEMA,
  type S3AliasConfig,
  type S3AliasConfigRedacted,
} from '../s3_alias.ts'

export interface AliyunConfig extends S3AliasConfig {
  region: string
}

export type AliyunConfigRedacted = S3AliasConfigRedacted

export const AliyunConfigSchema = REGION_ALIAS_SCHEMA

export const ALIAS = makeS3Alias<AliyunConfig, AliyunConfigRedacted>({
  schema: AliyunConfigSchema,
  endpointFor: (config) => `https://s3.oss-${config.region}.aliyuncs.com`,
})

export const resolvedAliyunEndpoint = ALIAS.resolvedEndpoint
export const aliyunToS3Config = ALIAS.toS3Config
