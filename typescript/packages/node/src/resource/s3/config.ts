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
  normalizeFields,
  redactConfigWithSchema,
  S3ConfigSchema as S3CoreConfigSchema,
  type S3Config as S3CoreConfig,
  type S3ConfigRedacted as S3CoreConfigRedacted,
  z,
} from '@struktoai/mirage-core'

export interface S3Config extends S3CoreConfig {
  profile?: string
}

export interface S3ConfigRedacted extends S3CoreConfigRedacted {
  profile?: string
}

export const S3ConfigSchema = S3CoreConfigSchema.extend({
  profile: z.string().optional(),
})

export function redactConfig(config: S3Config): S3ConfigRedacted {
  return redactConfigWithSchema(S3ConfigSchema, config) as unknown as S3ConfigRedacted
}

/**
 * Translate Python-style snake_case keys (as used in YAML configs and the
 * Python `S3Config`) to the TS-idiomatic camelCase fields. Already-camelCase
 * keys pass through unchanged so user code that constructs `S3Config`
 * directly keeps working.
 *
 * Python ↔ TS mapping:
 *   aws_access_key_id     ↔ accessKeyId
 *   aws_secret_access_key ↔ secretAccessKey
 *   aws_session_token     ↔ sessionToken
 *   aws_profile           ↔ profile
 *   endpoint_url          ↔ endpoint
 *   path_style            ↔ forcePathStyle
 *   timeout (sec, int)    ↔ timeoutMs (ms, number — converted ×1000)
 *   proxy                 ↔ (dropped — not yet supported in TS)
 */
export function normalizeS3Config(input: Record<string, unknown>): S3Config {
  return normalizeFields(input, {
    rename: {
      aws_access_key_id: 'accessKeyId',
      aws_secret_access_key: 'secretAccessKey',
      aws_session_token: 'sessionToken',
      aws_profile: 'profile',
      endpoint_url: 'endpoint',
      path_style: 'forcePathStyle',
      timeout: 'timeoutMs',
      key_prefix: 'keyPrefix',
    },
    transform: {
      timeout: (v: unknown) => (typeof v === 'number' ? v * 1000 : v),
    },
    drop: ['proxy'],
  }) as unknown as S3Config
}
