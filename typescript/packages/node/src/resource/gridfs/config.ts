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
  normalizeKeyPrefix,
  redactConfigWithSchema,
  secretStr,
  z,
} from '@struktoai/mirage-core'

export interface GridFSConfig {
  uri: string
  database: string
  bucket?: string
  keyPrefix?: string
  chunkSizeBytes?: number
}

const GridFSConfigSchema = z.object({
  uri: secretStr(),
  database: z.string(),
  bucket: z.string().optional(),
  keyPrefix: z.string().optional(),
  chunkSizeBytes: z.number().optional(),
})

export interface GridFSConfigRedacted extends Omit<GridFSConfig, 'uri'> {
  uri?: string
}

export function redactConfig(config: GridFSConfig): GridFSConfigRedacted {
  return redactConfigWithSchema(GridFSConfigSchema, config) as unknown as GridFSConfigRedacted
}

/**
 * Translate Python-style snake_case keys (as used in YAML configs and the
 * Python `GridFSConfig`) to the TS-idiomatic camelCase fields, and
 * normalize the key prefix the way the accessor expects.
 */
export function normalizeGridFSConfig(input: Record<string, unknown>): GridFSConfig {
  const norm = normalizeFields(input, {
    rename: {
      key_prefix: 'keyPrefix',
      chunk_size_bytes: 'chunkSizeBytes',
    },
  }) as unknown as GridFSConfig
  const prefix = normalizeKeyPrefix(norm.keyPrefix)
  if (prefix !== undefined) {
    norm.keyPrefix = prefix
  } else {
    delete norm.keyPrefix
  }
  return norm
}
