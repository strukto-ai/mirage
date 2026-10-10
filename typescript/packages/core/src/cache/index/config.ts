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

import { parseConfigWithSchema, refuseRepeatedFields, type ConfigOf } from '../../vfs/secrets.ts'

export const ResourceType = Object.freeze({
  FILE: 'file',
  FOLDER: 'folder',
} as const)

export type ResourceType = (typeof ResourceType)[keyof typeof ResourceType]

function isKind(resourceType: string | undefined, kind: ResourceType): boolean {
  if (resourceType === undefined) return false
  return resourceType === kind || resourceType.endsWith(`/${kind}`)
}

/**
 * Whether a row's type names a folder: `folder` or `<backend>/folder`. A
 * backend may spell its kinds under its own prefix (`dropbox/folder`); a type
 * outside that convention (`wandb/directory`) is neither kind, nor is
 * `undefined`, a row a map lookup did not find.
 */
export function isFolderKind(resourceType: string | undefined): boolean {
  return isKind(resourceType, ResourceType.FOLDER)
}

/** Whether a row's type names a file: `file` or `<backend>/file`; as `isFolderKind`. */
export function isFileKind(resourceType: string | undefined): boolean {
  return isKind(resourceType, ResourceType.FILE)
}

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
 * The wire form of an entry: what pydantic writes for the Python
 * `IndexEntry`, snake_case and every field, so a row either language writes
 * is one the other reads. Requiredness mirrors the pydantic model, so a row
 * missing `resource_type` is refused rather than decoded with the field
 * empty. `extra` rides along because it is load-bearing (`size_bytes`, the
 * `folder.childCount` that `find -empty` reads on Graph backends).
 */
export const IndexEntryWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  resource_type: z.string(),
  remote_time: z.string().default(''),
  index_time: z.string().default(''),
  vfs_name: z.string().default(''),
  size: z.number().int().nullable().default(null),
  extra: z.record(z.string(), z.unknown()).default({}),
})

export type IndexEntryWire = z.output<typeof IndexEntryWireSchema>

export interface IndexEntryInit {
  id: string
  name: string
  resourceType: string
  remoteTime?: string
  indexTime?: string
  vfsName?: string
  size?: number | null
  extra?: Record<string, unknown>
}

export class IndexEntry {
  id: string
  name: string
  resourceType: string
  remoteTime: string
  indexTime: string
  vfsName: string
  size: number | null
  extra: Record<string, unknown>

  constructor(init: IndexEntryInit) {
    this.id = init.id
    this.name = init.name
    this.resourceType = init.resourceType
    this.remoteTime = init.remoteTime ?? ''
    this.indexTime = init.indexTime ?? ''
    this.vfsName = init.vfsName ?? ''
    this.size = init.size ?? null
    this.extra = init.extra ?? {}
  }

  copyWith(updates: Partial<IndexEntryInit>): IndexEntry {
    return new IndexEntry({
      id: updates.id ?? this.id,
      name: updates.name ?? this.name,
      resourceType: updates.resourceType ?? this.resourceType,
      remoteTime: updates.remoteTime ?? this.remoteTime,
      indexTime: updates.indexTime ?? this.indexTime,
      vfsName: updates.vfsName ?? this.vfsName,
      size: updates.size !== undefined ? updates.size : this.size,
      extra: updates.extra ?? this.extra,
    })
  }

  /** The wire form, so `JSON.stringify(entry)` is what `model_dump_json` writes. */
  toJSON(): IndexEntryWire {
    return {
      id: this.id,
      name: this.name,
      resource_type: this.resourceType,
      remote_time: this.remoteTime,
      index_time: this.indexTime,
      vfs_name: this.vfsName,
      size: this.size,
      extra: this.extra,
    }
  }

  /** The twin of `model_validate_json`: a row the schema refuses throws. */
  static fromJSON(raw: string): IndexEntry {
    const w = IndexEntryWireSchema.parse(JSON.parse(raw))
    return new IndexEntry({
      id: w.id,
      name: w.name,
      resourceType: w.resource_type,
      remoteTime: w.remote_time,
      indexTime: w.index_time,
      vfsName: w.vfs_name,
      size: w.size,
      extra: w.extra,
    })
  }
}

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
  readonly entries: ReadonlyMap<string, IndexEntry>
  readonly children: ReadonlyMap<string, readonly string[]>
  /** The backend version the rows were read at, or null. */
  readonly version?: string | null
}

export interface LookupResult {
  entry?: IndexEntry | null
  status?: LookupStatus | null
}

export interface ListResult {
  entries?: string[] | null
  partialEntries?: string[] | null
  status?: LookupStatus | null
  version?: string | null
}

/** The directory row, the twin of the pydantic `IndexDirectory`. */
export const IndexDirectorySchema = z.object({
  entries: z.array(z.string()),
  expires_at: z.number(),
  generation: z.string(),
  partial: z.boolean().default(false),
  version: z.string().nullable().default(null),
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
