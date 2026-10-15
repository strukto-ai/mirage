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

export const EntityKind = {
  COLLECTION: 'collection',
  VIEW: 'view',
} as const
export type EntityKind = (typeof EntityKind)[keyof typeof EntityKind]

export const BsonTypeTag = {
  BOOL: 'bool',
  INT: 'int',
  LONG: 'long',
  DOUBLE: 'double',
  STRING: 'string',
  OBJECT_ID: 'objectId',
  DECIMAL: 'decimal',
  DATE: 'date',
  TIMESTAMP: 'timestamp',
  BINARY: 'binary',
  REGEX: 'regex',
  NULL: 'null',
  OBJECT: 'object',
  ARRAY: 'array',
  UNKNOWN: 'unknown',
} as const
export type BsonTypeTag = (typeof BsonTypeTag)[keyof typeof BsonTypeTag]

export const IndexType = {
  BTREE: 'btree',
  TEXT: 'text',
  HASHED: 'hashed',
  GEO_2D: '2d',
  GEO_2DSPHERE: '2dsphere',
  WILDCARD: 'wildcard',
} as const
export type IndexType = (typeof IndexType)[keyof typeof IndexType]

export const PRIMARY_KEY = '_id'

// The server error a snapshot read meets on a server outside a replica set.
export const NOT_A_REPLICA_SET = 123

// The databases the server keeps for itself, never listed on a mount.
export const SYSTEM_DATABASES: ReadonlySet<string> = new Set(['admin', 'local', 'config'])

export const RESOURCE_TYPE_DATABASE = 'mongodb/database'
const RESOURCE_TYPE_COLLECTION = 'mongodb/collection'
const RESOURCE_TYPE_VIEW = 'mongodb/view'

export const KIND_TO_DIR: Record<EntityKind, string> = {
  [EntityKind.COLLECTION]: 'collections',
  [EntityKind.VIEW]: 'views',
}

export const KIND_TO_RESOURCE_TYPE: Record<EntityKind, string> = {
  [EntityKind.COLLECTION]: RESOURCE_TYPE_COLLECTION,
  [EntityKind.VIEW]: RESOURCE_TYPE_VIEW,
}

export const KIND_DIR_NAMES: Record<string, EntityKind> = Object.fromEntries(
  Object.entries(KIND_TO_DIR).map(([k, v]) => [v, k as EntityKind]),
)
