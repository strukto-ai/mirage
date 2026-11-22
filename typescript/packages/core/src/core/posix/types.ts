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

/**
 * Runs one shell line where the files are: its exit status (null when a
 * signal ended it), its output and its error output.
 */
export type RunFn = (command: string) => Promise<[number | null, Uint8Array, Uint8Array]>

/** One entry of a `ENTRY_FORMAT` listing, as find printed it. */
export interface PosixEntry {
  /** find's type letter (`f`, `d`, `l`, `p`, ...). */
  readonly kind: string
  /** The permission bits. */
  readonly mode: number
  /** The size in bytes. */
  readonly size: number
  /** The modification time, in whole seconds, as SFTP reports it. */
  readonly mtime: number
  /** The access time, in whole seconds. */
  readonly atime: number
  /** The modification time, in epoch milliseconds. */
  readonly mtimeMs: number
  /** The access time, in epoch milliseconds. */
  readonly atimeMs: number
  /** The owner's uid. */
  readonly uid: number
  /** The group's gid. */
  readonly gid: number
  /** The link count. */
  readonly nlink: number
  /** The 512-byte blocks it takes. */
  readonly blocks: number
  /** The path under the listed scope, empty for the scope. */
  readonly rel: string
}
