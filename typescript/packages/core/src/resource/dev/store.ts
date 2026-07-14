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

export class DevFiles extends Map<string, Uint8Array> {
  override has(key: string): boolean {
    return DEV_NAMES.has(strip(key))
  }

  override get(key: string): Uint8Array | undefined {
    const name = strip(key)
    if (name === 'null') return new Uint8Array(0)
    if (name === 'zero') return new Uint8Array(ZERO_CHUNK_SIZE)
    return undefined
  }

  override set(_key: string, _value: Uint8Array): this {
    return this
  }

  override delete(_key: string): boolean {
    return false
  }

  override clear(): void {
    /* no-op: synthetic devices cannot be cleared */
  }

  override get size(): number {
    return DEV_NAMES.size
  }

  override *keys(): MapIterator<string> {
    yield '/null'
    yield '/zero'
  }

  override *values(): MapIterator<Uint8Array> {
    yield new Uint8Array(0)
    yield new Uint8Array(ZERO_CHUNK_SIZE)
  }

  override *entries(): MapIterator<[string, Uint8Array]> {
    yield ['/null', new Uint8Array(0)]
    yield ['/zero', new Uint8Array(ZERO_CHUNK_SIZE)]
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
