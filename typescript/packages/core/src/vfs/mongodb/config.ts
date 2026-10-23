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
import {
  type ConfigOf,
  parseConfigWithSchema,
  REDACTED_SECRET,
  type RedactedConfig,
  secretStr,
} from '../secrets.ts'

// `uri` is the credential, so it carries the secret marker the redactor
// reads; the rest are the knobs python's `MongoDBConfig` declares.
const MongoDBConfigSchema = z.object({
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

export type MongoDBConfig = ConfigOf<typeof MongoDBConfigSchema>

export interface MongoDBConfigResolved {
  uri: string
  databases: readonly string[] | null
  maxDocLimit: number
  elideFields: Record<string, readonly string[]>
}

export function normalizeMongoDBConfig(input: Record<string, unknown>): MongoDBConfig {
  return parseConfigWithSchema(MongoDBConfigSchema, input)
}

export function resolveMongoDBConfig(config: MongoDBConfig): MongoDBConfigResolved {
  return {
    uri: config.uri,
    databases: config.databases ?? null,
    maxDocLimit: config.maxDocLimit ?? 5000,
    elideFields: config.elideFields ?? {},
  }
}

// `uri` is the credential. Masking it is what makes
// `vfsStateRequiresOverride` demand a fresh one at load instead of
// quietly rebuilding the mount as an empty RAMVFS. Mirrors the
// field Python annotates secret on this config.
export type MongoDBConfigRedacted = RedactedConfig<MongoDBConfigResolved, 'uri'>

export function redactMongoDBConfig(config: MongoDBConfigResolved): MongoDBConfigRedacted {
  return { ...config, uri: REDACTED_SECRET }
}
