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
import type { DevicePipe } from '../../core/dev/pipe.ts'
import { activePipe } from '../../core/dev/device.ts'
import { norm } from '../../utils/path.ts'
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
  override readonly store: RAMStore
  override readonly accessor: RAMAccessor

  constructor(private readonly devices = new DevStore()) {
    super()
    this.store = devices as unknown as RAMStore
    this.accessor = new RAMAccessor(this.store)
  }

  forSession(owner: string): DevVFS {
    return new DevVFS(this.devices.forSession(owner))
  }

  allocateInput(pipe: DevicePipe): readonly [string, number] {
    return (this.store.files as DevFiles).allocateInput(pipe)
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
  override readStream(
    path: PathSpec,
    index?: IndexCacheStore,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    // Bound as the read opens, so a descriptor reads on after the pipe's path
    // is released.
    const pipe = activePipe(this.accessor, norm(path.mountPath))
    if (pipe !== null) return pipe.stream(path, signal)
    return this.readWhole(path, index)
  }

  private async *readWhole(path: PathSpec, index?: IndexCacheStore): AsyncIterable<Uint8Array> {
    const data = await this.read(path, index)
    if (data.byteLength > 0) yield data
  }
}
