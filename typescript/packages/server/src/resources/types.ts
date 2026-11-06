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

/** Where the daemon keeps saved configs: files under the mirage home, or memory for tests. */
export enum ResourceStoreBackend {
  Files = 'files',
  Memory = 'memory',
}

export type FieldType = 'string' | 'number' | 'boolean' | 'list'

/** One field of a type's config, as a config file writes it and as a `/types` route answers it. */
export interface Field {
  /** `token`, `base_url`; a block's field is `auth.token`. */
  name: string
  type: FieldType
  /** Marked secret by Mirage: kept sealed, never shown. */
  secret: boolean
  /** Mirage refuses the config without it (within its block, for a block's field). */
  required: boolean
  options?: string[]
  description?: string
  default?: string | number | boolean
  /** The optional block it belongs to, needed only when the block is used. */
  group?: string
}

/** Each type of a kind with its fields, by type name. */
export type TypeTable = Record<string, Field[]>
