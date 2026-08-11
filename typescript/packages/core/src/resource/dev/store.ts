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

import { stripSlash } from '../../utils/slash.ts'
import type { RAMAttrs } from '../ram/store.ts'

const DEV_NAMES = new Set(['null', 'zero'])
const ZERO_CHUNK_SIZE = 1 << 20

function strip(key: string): string {
  return stripSlash(key)
}

// Real backing store plus a synthetic /null, /zero overlay. The synthetic
// device names read as empty/zeros and swallow writes until they are
// deleted (GNU: `rm /dev/null` succeeds and the path is gone). A deleted
// name is tombstoned; the next write stores real bytes, which is GNU's
// rm-then-redirect recreation as a regular file.
export class DevFiles extends Map<string, Uint8Array> {
  private readonly tombstones = new Set<string>()

  private syntheticActive(name: string): boolean {
    return DEV_NAMES.has(name) && !this.tombstones.has(name) && !super.has('/' + name)
  }

  private syntheticBytes(name: string): Uint8Array {
    return name === 'null' ? new Uint8Array(0) : new Uint8Array(ZERO_CHUNK_SIZE)
  }

  override has(key: string): boolean {
    return super.has(key) || this.syntheticActive(strip(key))
  }

  override get(key: string): Uint8Array | undefined {
    if (super.has(key)) return super.get(key)
    const name = strip(key)
    if (this.syntheticActive(name)) return this.syntheticBytes(name)
    return undefined
  }

  override set(key: string, value: Uint8Array): this {
    const name = strip(key)
    if (this.syntheticActive(name)) return this
    super.set(key, value)
    this.tombstones.delete(name)
    return this
  }

  override delete(key: string): boolean {
    const name = strip(key)
    if (super.has(key)) {
      super.delete(key)
      if (DEV_NAMES.has(name)) this.tombstones.add(name)
      return true
    }
    if (this.syntheticActive(name)) {
      this.tombstones.add(name)
      return true
    }
    return false
  }

  override clear(): void {
    /* no-op: synthetic devices cannot be cleared */
  }

  override get size(): number {
    let synthetic = 0
    for (const name of ['null', 'zero']) {
      if (this.syntheticActive(name)) synthetic += 1
    }
    return synthetic + super.size
  }

  override *keys(): MapIterator<string> {
    for (const [k] of this.entries()) yield k
  }

  override *values(): MapIterator<Uint8Array> {
    for (const [, v] of this.entries()) yield v
  }

  override *entries(): MapIterator<[string, Uint8Array]> {
    for (const name of ['null', 'zero']) {
      if (this.syntheticActive(name)) yield ['/' + name, this.syntheticBytes(name)]
    }
    yield* super.entries()
  }

  override [Symbol.iterator](): MapIterator<[string, Uint8Array]> {
    return this.entries()
  }

  override forEach(
    callback: (value: Uint8Array, key: string, map: Map<string, Uint8Array>) => void,
    thisArg?: unknown,
  ): void {
    for (const [k, v] of this.entries()) {
      callback.call(thisArg, v, k, this)
    }
  }
}

export class DevStore {
  readonly files: Map<string, Uint8Array> = new DevFiles()
  readonly dirs = new Set<string>(['/'])
  readonly modified = new Map<string, string>()
  readonly attrs = new Map<string, RAMAttrs>()
}
