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

import { S3ConfigSchema as S3CoreConfigSchema } from '@struktoai/mirage-core/vfs/s3/config'
import { FIELD_NORMALIZERS } from '@struktoai/mirage-core/vfs/secrets'

// The one field whose camelCase spelling is not what `snakeToCamel` would
// produce, so it is the whole rename map for the browser's S3 family. Every
// other field (`key_prefix`, `default_content_type`, ...) round-trips through
// the default, and restating those only creates a second place to be wrong.
export const S3_BROWSER_RENAME: Record<string, string> = { endpoint_url: 'endpoint' }

// The core shape under the browser's own renames, so the core schema
// carries none of a host's spellings.
export const S3ConfigSchema = S3CoreConfigSchema.clone().register(FIELD_NORMALIZERS, {
  rename: S3_BROWSER_RENAME,
})

export type {
  S3BrowserOperation,
  S3BrowserPresignedUrlProvider,
  S3BrowserSignOptions,
  S3Config,
  S3ConfigRedacted,
} from '@struktoai/mirage-core/vfs/s3/config'
