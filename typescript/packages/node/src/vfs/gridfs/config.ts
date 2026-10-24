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

import { normalizeKeyPrefix } from '@struktoai/mirage-core/vfs/s3/config'
import {
  parseConfigWithSchema,
  redactConfigWithSchema,
  secretStr,
  z,
} from '@struktoai/mirage-core/vfs/secrets'
import type { ConfigOf, RedactedConfig } from '@struktoai/mirage-core/vfs/secrets'

const GridFSConfigSchema = z.object({
  uri: secretStr().describe('MongoDB connection URI.'),
  database: z.string().describe('Database that holds the GridFS bucket.'),
  bucket: z.string().optional().meta({
    description: 'GridFS bucket name; its collections are `<bucket>.files` and `<bucket>.chunks`.',
    default: 'fs',
  }),
  keyPrefix: z
    .string()
    .optional()
    .describe('Filename prefix the mount treats as its root; files outside it are not listed.'),
  chunkSizeBytes: z
    .number()
    .optional()
    .describe(
      "Chunk size in bytes for files the mount writes; unset uses the driver's default, 255 KiB.",
    ),
  keepRevisions: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Revisions kept per file, newest first: a write or an `rm` deletes the rest, under the file's name and in the trash `rm` moves revisions to (`/trash/<filename>`, which no mount path reaches). Unset keeps every revision, so a snapshot pinned to any of them still reads.",
    ),
  walkLimit: z.number().int().min(-1).optional().meta({
    description:
      'Most files one command walks under a folder: `grep -r`, `find` and other walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is refused. `-1` lifts the limit.',
    default: 1000,
  }),
})

export type GridFSConfig = ConfigOf<typeof GridFSConfigSchema>

export type GridFSConfigRedacted = RedactedConfig<GridFSConfig, 'uri'>

export function redactConfig(config: GridFSConfig): GridFSConfigRedacted {
  return redactConfigWithSchema(GridFSConfigSchema, config) as unknown as GridFSConfigRedacted
}

/**
 * Translate Python-style snake_case keys (as used in YAML configs and the
 * Python `GridFSConfig`) to the TS-idiomatic camelCase fields, and
 * normalize the key prefix the way the accessor expects.
 */
export function normalizeGridFSConfig(input: Record<string, unknown>): GridFSConfig {
  const norm = parseConfigWithSchema(GridFSConfigSchema, input)
  const prefix = normalizeKeyPrefix(norm.keyPrefix)
  if (prefix !== undefined) {
    norm.keyPrefix = prefix
  } else {
    delete norm.keyPrefix
  }
  return norm
}
