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

import type { StorageUsage } from '../capacity.ts'

export interface RAMAttrs {
  mode?: number
  uid?: number | string
  gid?: number | string
  atime?: string
}

/**
 * A RAM store's file table, keeping `held` equal to the bytes it holds, and
 * `usage.used` too when a capacity caps the store. Counting here, rather than
 * at each op, means no change to the table can miss the count; the
 * workspace's `max_memory` sums `held`. It refuses nothing: an op checks
 * growth with `checkCapacity` before it stores, in the same synchronous step.
 *
 * A file `splice` grew is a view of a buffer the table keeps, so a run of
 * appends or pwrites past its end lands in place; a reader's view ends where
 * the file did, so the bytes it holds never change. Mirrors Python's
 * `RAMFiles`.
 */
export class RAMFiles extends Map<string, Uint8Array> {
  /** The bytes the table holds, which the workspace's `max_memory` sums. */
  held = 0
  /** The buffer each key `splice` grew, whose prefix the key's view is. */
  private readonly grown = new Map<string, Uint8Array>()

  constructor(readonly usage: StorageUsage | null = null) {
    super()
  }

  private count(delta: number): void {
    this.held += delta
    const usage = this.usage
    if (usage !== null && usage.used !== null) usage.used += delta
  }

  override set(key: string, value: Uint8Array): this {
    this.count(value.byteLength - (this.get(key)?.byteLength ?? 0))
    this.grown.delete(key)
    return super.set(key, value)
  }

  override delete(key: string): boolean {
    this.count(-(this.get(key)?.byteLength ?? 0))
    this.grown.delete(key)
    return super.delete(key)
  }

  override clear(): void {
    super.clear()
    this.grown.clear()
    this.held = 0
    if (this.usage !== null) this.usage.used = 0
  }

  /**
   * Write `data` at `offset` of `key`, as pwrite(2) leaves a file: a gap past
   * its end reads as zeros, a missing key is created, and writing nothing
   * changes nothing. Bytes past the end land in the key's buffer, grown by
   * half again when full; an overwrite copies the file first, since a reader
   * may still view the bytes it replaces.
   */
  splice(key: string, offset: number, data: Uint8Array): void {
    const current = this.get(key) ?? new Uint8Array()
    if (data.byteLength === 0) {
      if (!this.has(key)) this.set(key, current)
      return
    }
    const length = Math.max(current.byteLength, offset + data.byteLength)
    let buffer = this.grown.get(key)
    if (buffer === undefined || offset < current.byteLength || length > buffer.byteLength) {
      buffer = new Uint8Array(Math.floor(length * 1.5))
      buffer.set(current)
    }
    buffer.fill(0, current.byteLength, offset)
    buffer.set(data, offset)
    this.set(key, buffer.subarray(0, length))
    this.grown.set(key, buffer)
  }
}

export class RAMStore {
  readonly files: Map<string, Uint8Array> & Pick<RAMFiles, 'splice'>
  readonly dirs = new Set<string>(['/'])
  readonly modified = new Map<string, string>()
  readonly attrs = new Map<string, RAMAttrs>()

  /** `usage` is the store's capacity and counted bytes, null when uncapped. */
  constructor(readonly usage: StorageUsage | null = null) {
    this.files = new RAMFiles(usage)
  }
}
