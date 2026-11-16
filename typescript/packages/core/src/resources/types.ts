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

import type { JsonValue } from '../types.ts'

/** A kind whose entries hold a type's fields, some of them sealed. */
export type EntryKind = 'vfs' | 'cli' | 'machine' | 'store'

/** Every kind of saved config a store keeps. */
export type ResourceKind = EntryKind | 'policy' | 'template'

export type Fields = Record<string, JsonValue>

/** A vfs, cli, machine or store entry as the API answers it: sealed fields by name only. */
export interface Entry {
  readonly name: string
  readonly type: string
  readonly fields: Fields
  /** The names of the sealed fields that hold a value, sorted. */
  readonly sealed: readonly string[]
}

/** An entry with its sealed values in the clear, for building a workspace, never for an answer. */
export interface RevealedEntry {
  readonly name: string
  readonly type: string
  readonly fields: Fields
  readonly sealed: Fields
}

/**
 * An entry to save. `fields` replaces the plain fields. A sealed field left
 * out of `sealed` keeps its value, one given as null is removed, and one
 * named in `fields` is replaced by that plain value.
 */
export interface EntryInput {
  readonly name: string
  readonly type: string
  readonly fields: Fields
  readonly sealed?: Readonly<Record<string, JsonValue | null>>
}

export interface Policy {
  readonly name: string
  readonly source: string
}

export interface Template {
  readonly name: string
  readonly description: string | null
  readonly config: Fields
}

export interface TemplateInput {
  readonly name: string
  readonly description?: string | null
  readonly config: Fields
}

/** Plain records by folder and name: what a backend stores in the open. */
export interface ResourceRecords {
  read(folder: string, name: string): Promise<Fields | null>
  write(folder: string, name: string, record: Fields): Promise<void>
  /** Whether there was a record to remove. */
  remove(folder: string, name: string): Promise<boolean>
  names(folder: string): Promise<string[]>
}

/** Where a backend keeps an entry's sealed values, apart from its record. */
export interface Sealer {
  /** The sealed values, or `{}` when there are none. */
  read(kind: EntryKind, name: string): Promise<Fields>
  /** Replace the sealed values; with none, the same as `wipe`. */
  write(kind: EntryKind, name: string, values: Fields): Promise<void>
  wipe(kind: EntryKind, name: string): Promise<void>
}
