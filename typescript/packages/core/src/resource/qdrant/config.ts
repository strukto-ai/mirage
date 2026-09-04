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

const QdrantConfigSchema = z.object({
  url: z.string().optional(),
  host: z.string().optional(),
  port: z.number().optional(),
  https: z.boolean().optional(),
  apiKey: secretStr().optional(),
  collection: z.string().optional(),
  groupBy: z.array(z.string()).optional(),
  basenameFields: z.array(z.string()).optional(),
  idField: z.string().optional(),
  nameField: z.string().optional(),
  textField: z.string().optional(),
  blobField: z.string().optional(),
  blobExt: z.string().optional(),
  vectorField: z.string().optional(),
  searchLimit: z.number().optional(),
  maxRows: z.number().optional(),
  embeddingModel: z.string().optional(),
})

export type QdrantConfig = ConfigOf<typeof QdrantConfigSchema>

export function normalizeQdrantConfig(input: Record<string, unknown>): QdrantConfig {
  return parseConfigWithSchema(QdrantConfigSchema, input)
}

export interface QdrantConfigResolved {
  url: string | null
  host: string
  port: number
  https: boolean
  apiKey: string | null
  collection: string | null
  groupBy: string[]
  basenameFields: string[]
  idField: string
  nameField: string | null
  textField: string | null
  blobField: string | null
  blobExt: string
  vectorField: string | null
  searchLimit: number
  maxRows: number
  embeddingModel: string
}

export function resolveQdrantConfig(config: QdrantConfig): QdrantConfigResolved {
  return {
    url: config.url ?? null,
    host: config.host ?? 'localhost',
    port: config.port ?? 6333,
    https: config.https ?? false,
    apiKey: config.apiKey ?? null,
    collection: config.collection ?? null,
    groupBy: config.groupBy ?? [],
    basenameFields: config.basenameFields ?? [],
    idField: config.idField ?? 'id',
    nameField: config.nameField ?? null,
    textField: config.textField ?? null,
    blobField: config.blobField ?? null,
    blobExt: config.blobExt ?? 'bin',
    vectorField: config.vectorField ?? null,
    searchLimit: config.searchLimit ?? 10,
    maxRows: config.maxRows ?? 1000,
    embeddingModel: config.embeddingModel ?? 'sentence-transformers/all-MiniLM-L6-v2',
  }
}

// `apiKey` is the credential, and it is the field Python annotates secret
// on this config. A null one stays null: a local Qdrant reached without a
// credential has nothing to mask, and planting the marker anyway would
// make `Workspace.load` demand a fresh config for a self-contained
// snapshot. Python's redactor skips None for the same reason.
export type QdrantConfigRedacted = RedactedConfig<QdrantConfigResolved, 'apiKey'>

export function redactQdrantConfig(config: QdrantConfigResolved): QdrantConfigRedacted {
  return { ...config, apiKey: config.apiKey === null ? null : REDACTED_SECRET }
}
