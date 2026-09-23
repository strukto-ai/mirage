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

const LanceDBConfigSchema = z.object({
  uri: z.string(),
  apiKey: secretStr().optional(),
  region: z.string().optional(),
  hostOverride: z.string().optional(),
  storageOptions: z.record(z.string(), z.string()).optional(),
  table: z.string().optional(),
  groupBy: z.array(z.string()).optional(),
  idColumn: z.string().optional(),
  titleColumn: z.string().optional(),
  blobColumn: z.string().optional(),
  blobExt: z.string().optional(),
  textColumn: z.string().optional(),
  vectorColumn: z.string().optional(),
  searchLimit: z.number().optional(),
  maxRows: z.number().optional(),
})

export type LanceDBConfig = ConfigOf<typeof LanceDBConfigSchema>

export function normalizeLanceDBConfig(input: Record<string, unknown>): LanceDBConfig {
  return parseConfigWithSchema(LanceDBConfigSchema, input)
}

export interface LanceDBConfigResolved {
  uri: string
  apiKey: string | null
  region: string
  hostOverride: string | null
  storageOptions: Record<string, string> | null
  table: string | null
  groupBy: string[]
  idColumn: string
  titleColumn: string | null
  blobColumn: string | null
  blobExt: string
  textColumn: string | null
  vectorColumn: string | null
  searchLimit: number
  maxRows: number
}

export function resolveLanceDBConfig(config: LanceDBConfig): LanceDBConfigResolved {
  return {
    uri: config.uri,
    apiKey: config.apiKey ?? null,
    region: config.region ?? 'us-east-1',
    hostOverride: config.hostOverride ?? null,
    storageOptions: config.storageOptions ?? null,
    table: config.table ?? null,
    groupBy: config.groupBy ?? [],
    idColumn: config.idColumn ?? 'id',
    titleColumn: config.titleColumn ?? null,
    blobColumn: config.blobColumn ?? null,
    blobExt: config.blobExt ?? 'bin',
    textColumn: config.textColumn ?? null,
    vectorColumn: config.vectorColumn ?? null,
    searchLimit: config.searchLimit ?? 10,
    maxRows: config.maxRows ?? 1000,
  }
}

// `apiKey` is the credential, and it is the field Python annotates secret
// on this config. A null one stays null: a local on-disk LanceDB has no
// credential to mask, and planting the marker anyway would make
// `Workspace.load` demand a fresh config for a self-contained snapshot.
// Python's redactor skips None for the same reason.
export type LanceDBConfigRedacted = RedactedConfig<LanceDBConfigResolved, 'apiKey'>

export function redactLanceDBConfig(config: LanceDBConfigResolved): LanceDBConfigRedacted {
  return { ...config, apiKey: config.apiKey === null ? null : REDACTED_SECRET }
}
