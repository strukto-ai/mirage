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
import type { S3Config as S3CoreConfig } from '@struktoai/mirage-core/vfs/s3/config'
import { FIELD_NORMALIZERS, secretStr, z } from '@struktoai/mirage-core/vfs/secrets'
import type { ConfigOf, RedactedConfig } from '@struktoai/mirage-core/vfs/secrets'
import type { FieldNormalizer } from '@struktoai/mirage-core/utils/normalize'

export interface S3Config extends S3CoreConfig {
  profile?: string
  proxy?: string
}

// Only the entries `snakeToCamel` would get wrong, shared by every
// S3-compatible alias: python spells the profile `aws_profile`, the endpoint
// `endpoint_url` and path style `path_style`. Every other field maps by default, so
// it does not belong here. One map rather than a copy per provider: oci and
// supabase each lost `path_style` when theirs were hand-copied, and
// `path_style: false` was honored on python and silently ignored here.
const S3_FAMILY_RENAME: Record<string, string> = {
  aws_profile: 'profile',
  endpoint_url: 'endpoint',
  path_style: 'forcePathStyle',
}

export const S3_FAMILY_NORMALIZER: FieldNormalizer = { rename: S3_FAMILY_RENAME }

export const S3ConfigSchema = S3CoreConfigSchema.extend({
  profile: z
    .string()
    .optional()
    .describe(
      'Named profile in the shared AWS config and credentials files that supplies credentials when no access key pair is given.',
    ),
  proxy: secretStr()
    .optional()
    .describe('Proxy URL for every HTTP and HTTPS request to the endpoint.'),
})
  // S3 proper also takes the credentials under boto3's `aws_` spellings.
  .register(FIELD_NORMALIZERS, {
    rename: {
      aws_access_key_id: 'accessKeyId',
      aws_secret_access_key: 'secretAccessKey',
      aws_session_token: 'sessionToken',
      ...S3_FAMILY_RENAME,
    },
  })

export type S3ConfigRedacted = RedactedConfig<
  ConfigOf<typeof S3ConfigSchema>,
  | 'accessKeyId'
  | 'secretAccessKey'
  | 'sessionToken'
  | 'presignedUrlProvider'
  | 'httpAgentProvider'
  | 'proxy'
>
