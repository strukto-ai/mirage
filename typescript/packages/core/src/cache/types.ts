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

import type { FileStat, PathSpec } from '../types.ts'
import type { ByteSource } from '../io/types.ts'
import type { Accessor } from '../accessor/base.ts'

/** The active cache operations a backend needs from its cache manager. */
export interface CacheInvalidator {
  cachedSizes(paths: readonly PathSpec[]): Promise<(number | null)[]>
  isCached(path: PathSpec): Promise<boolean>
  probedStat(path: PathSpec): FileStat | null
}

export interface CacheContextState {
  manager: CacheInvalidator | null
}

/** A replacement with no destination-state requirement. Mirrors Python's `AnyWrite`. */
export interface AnyWrite {
  readonly kind: 'any'
}
export interface AbsentWrite {
  readonly kind: 'absent'
}
export interface MatchWrite {
  readonly kind: 'match'
  readonly version: string
}
export type WriteCondition = AnyWrite | AbsentWrite | MatchWrite
export const ANY_WRITE: AnyWrite = { kind: 'any' }
export const ABSENT_WRITE: AbsentWrite = { kind: 'absent' }
export type ConditionMode = 'absent' | 'match'
export type ConditionSupport = Readonly<Partial<Record<WriteKind, readonly ConditionMode[]>>>
export interface ReplaceRequest {
  readonly path: PathSpec
  readonly body: ByteSource
  readonly condition: WriteCondition
}
export type RewriteWriteFn<Written = FileStat | null> = (
  request: ReplaceRequest,
) => Promise<Written>

/** The write context of the mount at `prefix`. */
export interface WriteBinding {
  prefix: string
  context: WriteContext | null
}

export interface SettledWrite {
  readonly owner: Accessor
  readonly scope: WriteBinding | null
  readonly path: string
  readonly kind: WriteKind
  readonly condition: WriteCondition
}

/**
 * A file's live tokens: the content token mirage compares, the native token
 * the backend's condition takes. Mirrors Python's `LiveVersion`.
 */
export interface LiveVersion {
  readonly content: string | null
  readonly native: string | null
}

/**
 * What a write on a `write: conditional` mount needs to know. Bound by the
 * mount's own entry points (`runWithCaches`, `runWithWriteRevisions`), so a write always sees
 * the context of the mount it lands on; an unconditional mount binds null,
 * which also clears an outer one. Mirrors Python's `WriteContext`.
 */
export interface WriteContext {
  readonly vfs: string
  /** The ops the backend can condition: put, copy, delete. */
  readonly conditions: readonly WriteKind[]
  /** The version the mount last saw for a path, null when it saw none. */
  readVersion(path: PathSpec): Promise<string | null>
  /** `readVersion` for many paths at once, in one store round trip. */
  readVersions(paths: readonly PathSpec[]): Promise<(string | null)[]>
  /** Drops the mount's cached copy, so the read a refusal asks for fetches. */
  drop(path: PathSpec): Promise<void>
  /** Keeps a version for a path without bytes, the one a refused write lost on. */
  keep(path: PathSpec, version: string): Promise<void>
}

export type WriteKind = 'put' | 'copy' | 'delete'

/**
 * The version the mount last saw for each of a walk's backend keys, by key,
 * for the keys it saw one for.
 */
export type KnownVersions = (keys: readonly string[]) => Promise<Map<string, string>>

/** An op's own read that found no file, as against one it never made. */
export enum OwnRead {
  ABSENT = 0,
}

/** The version a key was measured on, or ABSENT for a key found gone. */
export type Measured = string | OwnRead
