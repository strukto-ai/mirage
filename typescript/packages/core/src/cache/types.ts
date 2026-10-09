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

import type { PathSpec } from '../types.ts'

/**
 * The precondition one write carries; empty when mirage holds no version of
 * the object, so the write goes out plain, there being nothing to compare.
 * Mirrors Python's `WriteCondition`.
 */
export interface WriteCondition {
  /** The version the object must still have. */
  readonly ifMatch?: string
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
