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
 * A RAM store's file table, keeping `usage.used` equal to the bytes it holds
 * when a capacity caps the store. Counting here, rather than at each op, means
 * no change to the table can miss the count. It refuses nothing: an op checks
 * growth with `checkCapacity` before it stores, in the same synchronous step.
 * Mirrors Python's `RAMFiles`.
 */
export class RAMFiles extends Map<string, Uint8Array> {
  constructor(readonly usage: StorageUsage | null = null) {
    super()
  }

  private count(delta: number): void {
    const usage = this.usage
    if (usage !== null && usage.used !== null) usage.used += delta
  }

  override set(key: string, value: Uint8Array): this {
    this.count(value.byteLength - (this.get(key)?.byteLength ?? 0))
    return super.set(key, value)
  }

  override delete(key: string): boolean {
    this.count(-(this.get(key)?.byteLength ?? 0))
    return super.delete(key)
  }

  override clear(): void {
    super.clear()
    if (this.usage !== null) this.usage.used = 0
  }
}

export class RAMStore {
  readonly files: Map<string, Uint8Array>
  readonly dirs = new Set<string>(['/'])
  readonly modified = new Map<string, string>()
  readonly attrs = new Map<string, RAMAttrs>()

  /** `usage` is the store's capacity and counted bytes, null when uncapped. */
  constructor(readonly usage: StorageUsage | null = null) {
    this.files = new RAMFiles(usage)
  }
}
