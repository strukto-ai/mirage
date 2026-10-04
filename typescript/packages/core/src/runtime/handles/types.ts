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

export type FlushKind = 'write' | 'append' | 'pwrite' | 'truncate'

/**
 * One op a closing handle owes the mount. Mirrors Python's `FlushStep`.
 *
 * `data` is the payload of a write, append or pwrite, `offset` where a
 * pwrite lands, and `length` the length a truncate leaves.
 */
export interface FlushStep {
  readonly kind: FlushKind
  readonly data?: Uint8Array
  readonly offset?: number
  readonly length?: number
}

/** The door's read of `(offset, size)`; a null size reads to the end. */
export type FileFetch = (offset: number, size: number | null) => Promise<Uint8Array>
