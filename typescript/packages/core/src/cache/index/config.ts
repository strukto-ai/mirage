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

import type { FileStat } from '../../types.ts'
import { ContentType, FileType } from '../../types.ts'
import { parseConfigWithSchema, refuseRepeatedFields, type ConfigOf } from '../../vfs/secrets.ts'

export const LookupStatus = Object.freeze({
  EXPIRED: 'expired',
  NOT_FOUND: 'not_found',
} as const)

export type LookupStatus = (typeof LookupStatus)[keyof typeof LookupStatus]

/** A name missing from a cached listing this command did not fetch. */
export const ListedMiss = Object.freeze({ UNTRUSTED: 'untrusted' } as const)

export type ListedMiss = (typeof ListedMiss)[keyof typeof ListedMiss]

export const IndexType = Object.freeze({
  RAM: 'ram',
  REDIS: 'redis',
} as const)

export type IndexType = (typeof IndexType)[keyof typeof IndexType]

/**
 * The wire form of a stat row: what pydantic writes for the Python
 * `FileStat`, which `JSON.stringify` of a `FileStat` already matches field
 * for field and in order.
 */
export const FileStatWireSchema = z.object({
  name: z.string(),
  size: z.number().int().nullable().default(null),
  modified: z.string().nullable().default(null),
  fingerprint: z.string().nullable().default(null),
  revision: z.string().nullable().default(null),
  type: z.enum(Object.values(FileType) as [FileType, ...FileType[]]),
  content: z
    .enum(Object.values(ContentType) as [ContentType, ...ContentType[]])
    .nullable()
    .default(null),
  mode: z.number().int().nullable().default(null),
  uid: z.union([z.number(), z.string()]).nullable().default(null),
  gid: z.union([z.number(), z.string()]).nullable().default(null),
  atime: z.string().nullable().default(null),
  ctime: z.string().nullable().default(null),
  birthtime: z.string().nullable().default(null),
  dev: z.number().int().nullable().default(null),
  extra: z.record(z.string(), z.unknown()).default({}),
})

/**
 * A child a complete re-list no longer names. `folder` says whether it held
 * a listing or was typed a folder, so cleanup takes everything beneath it.
 */
export interface Evicted {
  readonly path: string
  readonly folder: boolean
}

/** How a complete listing is written. */
export interface SetDirOptions {
  /**
   * The entries are a capped window (the newest N messages, the last N
   * days): served as the listing, but they prove nothing absent.
   */
  readonly window?: boolean
  /** Nested mount roots whose rows and descendants must survive. */
  readonly excluded?: readonly string[]
  /**
   * The backend version the listing was read at. It replaces the stored
   * one, and null or unset clears it.
   */
  readonly version?: string | null
}

/** Entry rows and directory children from one refill. */
export interface IndexSnapshot {
  readonly entries: ReadonlyMap<string, FileStat>
  readonly children: ReadonlyMap<string, readonly string[]>
  /** The backend version the rows were read at, or null. */
  readonly version?: string | null
}

export interface LookupResult {
  /** The row at the path. */
  entry?: FileStat | null
  status?: LookupStatus | null
}

export interface ListResult {
  entries?: string[] | null
  partialEntries?: string[] | null
  status?: LookupStatus | null
  version?: string | null
  // A capped window (the newest messages, the last days): served as the
  // listing but proves nothing absent.
  window?: boolean
}

/** The directory row, the twin of the pydantic `IndexDirectory`. */
export const IndexDirectorySchema = z.object({
  entries: z.array(z.string()),
  expires_at: z.number(),
  generation: z.string(),
  partial: z.boolean().default(false),
  version: z.string().nullable().default(null),
  window: z.boolean().default(false),
})

export type IndexDirectory = z.output<typeof IndexDirectorySchema>

const IndexConfigSchema = z.object({
  type: z.enum(IndexType).optional(),
  ttl: z.number().optional(),
})

const RedisIndexConfigSchema = IndexConfigSchema.extend({
  url: z.string().optional(),
  keyPrefix: z.string().optional(),
})

export type IndexConfig = ConfigOf<typeof IndexConfigSchema>

export type RedisIndexConfig = ConfigOf<typeof RedisIndexConfigSchema>

/**
 * Check an index config the way python's `IndexConfig` checks one on
 * construction, and camelize its keys.
 *
 * The fields are picked by `type`, where python picks them by class, since
 * a TS config has no class to pick by. One field named in both spellings is
 * refused, as python refuses the camelCase one.
 *
 * @param config the index config as the caller passed it.
 * @returns the checked config with every key in its camelCase spelling.
 */
export function normalizeIndexConfig(config: IndexConfig): IndexConfig {
  const input = config as Record<string, unknown>
  refuseRepeatedFields(input)
  return (input.type ?? IndexType.RAM) === IndexType.RAM
    ? parseConfigWithSchema(IndexConfigSchema, input)
    : parseConfigWithSchema(RedisIndexConfigSchema, input)
}
