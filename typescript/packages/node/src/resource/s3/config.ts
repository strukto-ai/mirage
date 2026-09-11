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

import { S3ConfigSchema as S3CoreConfigSchema } from '@struktoai/mirage-core/resource/s3/config'
import type { S3Config as S3CoreConfig } from '@struktoai/mirage-core/resource/s3/config'
import {
  parseConfigWithSchema,
  redactConfigWithSchema,
  secretStr,
  z,
} from '@struktoai/mirage-core/resource/secrets'
import type { ConfigOf, RedactedConfig } from '@struktoai/mirage-core/resource/secrets'
import { type FieldNormalizer, secondsToMs } from '@struktoai/mirage-core/utils/normalize'

export interface S3Config extends S3CoreConfig {
  profile?: string
  proxy?: string
}

const S3ConfigSchema = S3CoreConfigSchema.extend({
  profile: z.string().optional(),
  proxy: secretStr().optional(),
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

export function redactConfig(config: S3Config): S3ConfigRedacted {
  return redactConfigWithSchema(S3ConfigSchema, config) as unknown as S3ConfigRedacted
}

// Only the entries `snakeToCamel` would get wrong, shared by every
// S3-compatible alias: python spells the profile `aws_profile`, the endpoint
// `endpoint_url`, path style `path_style`, and states timeouts in seconds
// where TypeScript uses milliseconds. Every other field maps by default, so
// it does not belong here. One map rather than a copy per provider: oci and
// supabase each lost `path_style` when theirs were hand-copied, and
// `path_style: false` was honored on python and silently ignored here.
const S3_FAMILY_RENAME: Record<string, string> = {
  aws_profile: 'profile',
  endpoint_url: 'endpoint',
  path_style: 'forcePathStyle',
  timeout: 'timeoutMs',
}

const S3_FAMILY_TRANSFORM = { timeout: secondsToMs }

export const S3_FAMILY_NORMALIZER: FieldNormalizer = {
  rename: S3_FAMILY_RENAME,
  transform: S3_FAMILY_TRANSFORM,
}

// S3 proper also takes the credentials under boto3's `aws_` spellings.
const S3_NORMALIZER: FieldNormalizer = {
  rename: {
    aws_access_key_id: 'accessKeyId',
    aws_secret_access_key: 'secretAccessKey',
    aws_session_token: 'sessionToken',
    ...S3_FAMILY_RENAME,
  },
  transform: S3_FAMILY_TRANSFORM,
}

/**
 * Translate Python-style snake_case keys (as used in YAML configs and the
 * Python `S3Config`) to the TS-idiomatic camelCase fields, then validate.
 * Already-camelCase keys pass through unchanged so user code that
 * constructs `S3Config` directly keeps working.
 */
export function normalizeS3Config(input: Record<string, unknown>): S3Config {
  return parseConfigWithSchema(S3ConfigSchema, input, S3_NORMALIZER)
}
