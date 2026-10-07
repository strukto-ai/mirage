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

import type { Evicted } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { RAMAccessor } from '../../accessor/ram.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'

import { RAMVFS } from '../ram/ram.ts'
import type { RAMStore } from '../ram/store.ts'
import { type DevFiles, DevStore } from './store.ts'

/**
 * The index every DevVFS runs under: it never keeps an entry,
 * because a path-only index would publish one session's descriptors to
 * another. Mirrors the `NULL_INDEX` Python's registry uses for DevVFS.
 */
export class DevIndex extends RAMIndexCacheStore {
  override seed(): void {
    return undefined
  }
  override put(): Promise<void> {
    return Promise.resolve()
  }
  override setDir(): Promise<Evicted[]> {
    return Promise.resolve([])
  }
}

export class DevVFS extends RAMVFS {
  override readonly store: RAMStore = new DevStore() as unknown as RAMStore
  override readonly accessor: RAMAccessor = new RAMAccessor(this.store)

  allocateInput(): readonly [string, number] {
    return (this.store.files as DevFiles).allocateInput()
  }

  setInput(path: string, allocation: number, data: Uint8Array): void {
    const files = this.store.files as DevFiles
    files.setInput(path, allocation, data)
  }

  releaseInput(path: string, allocation: number): void {
    const files = this.store.files as DevFiles
    if (files.releaseInput(path, allocation)) {
      this.store.modified.delete(path.slice(4))
      this.store.attrs.delete(path.slice(4))
    }
  }

  /**
   * The stream is finite: a command that consumes a whole input reads the
   * refusing read, and only the two bounded streaming commands opt into the
   * endless source (`commands/builtin/dev`).
   */
  override async *readStream(path: PathSpec, index?: IndexCacheStore): AsyncIterable<Uint8Array> {
    const data = await this.read(path, index)
    if (data.byteLength > 0) yield data
  }
}
