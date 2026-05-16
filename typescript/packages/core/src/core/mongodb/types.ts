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

export const ScopeLevel = {
  ROOT: 'root',
  DATABASE: 'database',
  DATABASE_JSON: 'database_json',
  KIND_DIR: 'kind_dir',
  ENTITY: 'entity',
  SCHEMA_JSON: 'schema_json',
  DOCUMENTS: 'documents',
  UNKNOWN: 'unknown',
} as const
export type ScopeLevel = (typeof ScopeLevel)[keyof typeof ScopeLevel]

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

export const RESOURCE_TYPE_DATABASE = 'mongodb/database'
export const RESOURCE_TYPE_COLLECTION = 'mongodb/collection'
export const RESOURCE_TYPE_VIEW = 'mongodb/view'

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
