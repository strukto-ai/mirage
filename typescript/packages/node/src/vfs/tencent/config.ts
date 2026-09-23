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

export interface TencentConfig extends S3AliasConfig {
  region: string
}

export type TencentConfigRedacted = S3AliasConfigRedacted

const alias = makeRegionAlias<TencentConfig, TencentConfigRedacted>(
  (config) => `https://cos.${config.region}.myqcloud.com`,
)

export const resolvedTencentEndpoint = alias.resolvedEndpoint
export const tencentToS3Config = alias.toS3Config
export const redactTencentConfig = alias.redact
export const normalizeTencentConfig = alias.normalize
