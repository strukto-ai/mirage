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

import { liveSessions } from '../../context/session_context.ts'
import { enoent, eacces } from '../../errors/fs.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { RAMAttrs } from '../ram/store.ts'

const DEV_NAMES = new Set(['null', 'zero'])

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
  private readonly inputs = new Map<
    string,
    { owner: string; allocation: number; data: Uint8Array }
  >()
  private nextAllocation = 0

  private owner(): string | null {
    const sessions = liveSessions()
    const owner = sessions[0]?.sessionId
    // The browser fallback cannot distinguish overlapping sessions: fail closed.
    return owner !== undefined && sessions.every((session) => session.sessionId === owner)
      ? owner
      : null
  }

  visibleInputs(): Map<string, Uint8Array> {
    const owner = this.owner()
    return new Map(
      [...this.inputs]
        .filter(([, row]) => owner !== null && row.owner === owner)
        .map(([key, row]) => [key, row.data]),
    )
  }

  allocateInput(): readonly [string, number] {
    const owner = this.owner()
    if (owner === null) throw eacces('/dev/fd')
    let fd = 63
    while (this.inputs.has(`/fd/${String(fd)}`)) fd -= 1
    const key = `/fd/${String(fd)}`
    const allocation = this.nextAllocation++
    this.inputs.set(key, { owner, allocation, data: new Uint8Array() })
    return [`/dev${key}`, allocation]
  }

  setInput(path: string, allocation: number, data: Uint8Array): void {
    const row = this.inputs.get(path.slice(4))
    if (row?.allocation !== allocation) throw enoent(path)
    this.set(path.slice(4), data)
  }

  releaseInput(path: string, allocation: number): boolean {
    const row = this.inputs.get(path.slice(4))
    if (row?.allocation !== allocation) return false
    return this.inputs.delete(path.slice(4))
  }

  private syntheticActive(name: string): boolean {
    return DEV_NAMES.has(name) && !this.tombstones.has(name) && !super.has('/' + name)
  }

  private syntheticBytes(_name: string): Uint8Array {
    // Content is served by the device reader. Store iteration stays finite
    // and size-neutral so generic metadata operations never allocate zeros.
    return new Uint8Array(0)
  }

  deviceOf(key: string): string | null {
    const name = strip(key)
    return this.syntheticActive(name) ? name : null
  }

  override has(key: string): boolean {
    if (key.startsWith('/fd/')) return this.visibleInputs().has(key)
    return super.has(key) || this.syntheticActive(strip(key))
  }

  override get(key: string): Uint8Array | undefined {
    if (key.startsWith('/fd/')) return this.visibleInputs().get(key)
    if (super.has(key)) return super.get(key)
    const name = strip(key)
    if (this.syntheticActive(name)) return this.syntheticBytes(name)
    return undefined
  }

  override set(key: string, value: Uint8Array): this {
    if (key === '/fd' || key.startsWith('/fd/')) {
      const row = this.inputs.get(key)
      if (row === undefined || !this.visibleInputs().has(key)) throw enoent(`/dev${key}`)
      this.inputs.set(key, { ...row, data: value })
      return this
    }
    const name = strip(key)
    if (this.syntheticActive(name)) return this
    super.set(key, value)
    this.tombstones.delete(name)
    return this
  }

  override delete(key: string): boolean {
    if (key.startsWith('/fd/')) {
      if (!this.visibleInputs().has(key)) return false
      return this.inputs.delete(key)
    }
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
    return synthetic + super.size + this.visibleInputs().size
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
    yield* this.visibleInputs()
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

class DevDirs extends Set<string> {
  constructor(private readonly files: DevFiles) {
    super()
    super.add('/')
  }

  override has(key: string): boolean {
    return key === '/fd' ? this.files.visibleInputs().size > 0 : super.has(key)
  }

  override *[Symbol.iterator](): SetIterator<string> {
    yield* super[Symbol.iterator]()
    if (this.has('/fd')) yield '/fd'
  }

  override add(key: string): this {
    if (key === '/fd' || key.startsWith('/fd/')) throw eacces(`/dev${key}`)
    return super.add(key)
  }

  override delete(key: string): boolean {
    if (key === '/fd' || key.startsWith('/fd/')) throw eacces(`/dev${key}`)
    return super.delete(key)
  }
}

export class DevStore {
  readonly files = new DevFiles()
  readonly dirs = new DevDirs(this.files)
  readonly modified = new Map<string, string>()
  readonly attrs = new Map<string, RAMAttrs>()
}
