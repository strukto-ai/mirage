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

import { z } from 'zod'
import { timeoutShape } from '../../core/api/config.ts'
import { DEFAULT_TIMEOUT } from '../../core/api/constants.ts'
import type { ConfigOf, RedactedSchema } from '../secrets.ts'
import { REDACTED_SECRET, secretStr } from '../secrets.ts'

// `uri` is the credential, so it carries the secret marker the redactor
// reads; the rest are the knobs python's `MongoDBConfig` declares.
export const MongoDBConfig = z.object({
  ...timeoutShape,
  uri: secretStr().describe(
    'MongoDB connection URI in Node; in the browser, the URL of a backend route that holds the connection URI.',
  ),
  databases: z
    .array(z.string())
    .readonly()
    .optional()
    .describe(
      'Databases to mount; others are hidden. Unset or empty mounts every database except `admin`, `config` and `local`.',
    ),
  maxDocLimit: z.number().optional().meta({
    description:
      'Most documents one `tail -n` read of `documents.jsonl` fetches; a larger count on a collection that holds more is refused (`File too large`).',
    default: 5000,
  }),
  elideFields: z.record(z.string(), z.array(z.string()).readonly()).optional().meta({
    description:
      "Fields dropped from `documents.jsonl`, keyed by `<database>.<collection>` (a view's name works too); a dotted path such as `nested.path` drops a nested field.",
    default: {},
  }),
})

export type MongoDBConfig = ConfigOf<typeof MongoDBConfig>

export function resolveMongoDBConfig(config: MongoDBConfig) {
  return {
    timeout: config.timeout ?? DEFAULT_TIMEOUT,
    uri: config.uri,
    databases: config.databases ?? null,
    maxDocLimit: config.maxDocLimit ?? 5000,
    elideFields: config.elideFields ?? {},
  }
}

export function redactMongoDBConfig(
  config: ReturnType<typeof resolveMongoDBConfig>,
): RedactedSchema<typeof MongoDBConfig, ReturnType<typeof resolveMongoDBConfig>> {
  return { ...config, uri: REDACTED_SECRET }
}
