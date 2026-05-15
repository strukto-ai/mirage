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

export const ResourceType = Object.freeze({
  FILE: 'file',
  FOLDER: 'folder',
} as const)

export type ResourceType = (typeof ResourceType)[keyof typeof ResourceType]

export const LookupStatus = Object.freeze({
  EXPIRED: 'expired',
  NOT_FOUND: 'not_found',
} as const)

export type LookupStatus = (typeof LookupStatus)[keyof typeof LookupStatus]

export const IndexType = Object.freeze({
  RAM: 'ram',
  REDIS: 'redis',
} as const)

export type IndexType = (typeof IndexType)[keyof typeof IndexType]

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
}

export interface LookupResult {
  entry?: IndexEntry | null
  status?: LookupStatus | null
}

export interface ListResult {
  entries?: string[] | null
  status?: LookupStatus | null
}

export interface IndexConfig {
  type?: IndexType
  ttl?: number
}

export interface RedisIndexConfig extends IndexConfig {
  url?: string
  keyPrefix?: string
}
