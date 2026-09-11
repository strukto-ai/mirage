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
import { type ConfigOf, parseConfigWithSchema } from '../secrets.ts'

const ChromaConfigSchema = z.object({
  host: z.string().optional(),
  port: z.number().optional(),
  ssl: z.boolean().optional(),
  collectionName: z.string(),
  slugField: z.string().optional(),
  chunkIndexField: z.string().optional(),
})

export type ChromaConfig = ConfigOf<typeof ChromaConfigSchema>

export function normalizeChromaConfig(input: Record<string, unknown>): ChromaConfig {
  return parseConfigWithSchema(ChromaConfigSchema, input)
}

export interface ChromaConfigResolved {
  host: string
  port: number
  ssl: boolean
  collectionName: string
  slugField: string
  chunkIndexField: string
}

function normalizeNonEmpty(value: string, field: string): string {
  const normalized = value.trim()
  if (normalized === '') {
    throw new Error(`${field} cannot be empty`)
  }
  return normalized
}

export function resolveChromaConfig(config: ChromaConfig): ChromaConfigResolved {
  return {
    host: config.host ?? 'localhost',
    port: config.port ?? 8000,
    ssl: config.ssl ?? false,
    collectionName: normalizeNonEmpty(config.collectionName, 'collectionName'),
    slugField: normalizeNonEmpty(config.slugField ?? 'page_slug', 'slugField'),
    chunkIndexField: normalizeNonEmpty(config.chunkIndexField ?? 'chunk_index', 'chunkIndexField'),
  }
}

// No credential in this config, so the snapshot carries it whole and
// `Workspace.load` needs no override for the mount.
export type ChromaConfigRedacted = ChromaConfigResolved

export function redactChromaConfig(config: ChromaConfigResolved): ChromaConfigRedacted {
  return { ...config }
}
