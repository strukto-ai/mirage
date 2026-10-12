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

import { PipeFiles } from '../../core/dev/mixin.ts'
import type { DevicePipe } from '../../core/dev/pipe.ts'
import type { DevFileState } from './types.ts'
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
export class DevFiles extends PipeFiles {
  constructor(
    private readonly boundOwner?: string,
    readonly state: DevFileState = {
      files: new Map(),
      dirs: new Set(['/']),
      tombstones: new Set(),
      inputs: new Map(),
      nextAllocation: 0,
    },
  ) {
    super()
  }

  forSession(owner: string): DevFiles {
    return new DevFiles(owner, this.state)
  }

  pipeOf(key: string): DevicePipe | null {
    const row = this.state.inputs.get(key)
    return row?.owner === this.owner() ? (row.pipe ?? null) : null
  }

  private owner(): string | null {
    if (this.boundOwner !== undefined) return this.boundOwner
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
      [...this.state.inputs]
        .filter(([, row]) => owner !== null && row.owner === owner)
        .map(([key, row]) => [key, row.data]),
    )
  }

  allocateInput(pipe?: DevicePipe): readonly [string, number] {
    const owner = this.owner()
    if (owner === null) throw eacces('/dev/fd')
    let fd = 63
    while (this.state.inputs.has(`/fd/${String(fd)}`)) fd -= 1
    const key = `/fd/${String(fd)}`
    const allocation = this.state.nextAllocation++
    this.state.inputs.set(key, {
      owner,
      allocation,
      data: new Uint8Array(),
      ...(pipe === undefined ? {} : { pipe }),
    })
    return [`/dev${key}`, allocation]
  }

  setInput(path: string, allocation: number, data: Uint8Array): void {
    const row = this.state.inputs.get(path.slice(4))
    if (row?.allocation !== allocation) throw enoent(path)
    this.set(path.slice(4), data)
  }

  releaseInput(path: string, allocation: number): boolean {
    const row = this.state.inputs.get(path.slice(4))
    if (row?.allocation !== allocation) return false
    return this.state.inputs.delete(path.slice(4))
  }

  private syntheticActive(name: string): boolean {
    return (
      DEV_NAMES.has(name) && !this.state.tombstones.has(name) && !this.state.files.has('/' + name)
    )
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
    return this.state.files.has(key) || this.syntheticActive(strip(key))
  }

  override get(key: string): Uint8Array | undefined {
    if (key.startsWith('/fd/')) return this.visibleInputs().get(key)
    if (this.state.files.has(key)) return this.state.files.get(key)
    const name = strip(key)
    if (this.syntheticActive(name)) return this.syntheticBytes(name)
    return undefined
  }

  override set(key: string, value: Uint8Array): this {
    if (key === '/fd' || key.startsWith('/fd/')) {
      const row = this.state.inputs.get(key)
      if (row === undefined || !this.visibleInputs().has(key)) throw enoent(`/dev${key}`)
      this.state.inputs.set(key, { ...row, data: value })
      return this
    }
    const name = strip(key)
    if (this.syntheticActive(name)) return this
    this.state.files.set(key, value)
    this.state.tombstones.delete(name)
    return this
  }

  override delete(key: string): boolean {
    if (key.startsWith('/fd/')) {
      if (!this.visibleInputs().has(key)) return false
      return this.state.inputs.delete(key)
    }
    const name = strip(key)
    if (this.state.files.has(key)) {
      this.state.files.delete(key)
      if (DEV_NAMES.has(name)) this.state.tombstones.add(name)
      return true
    }
    if (this.syntheticActive(name)) {
      this.state.tombstones.add(name)
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
    return synthetic + this.state.files.size + this.visibleInputs().size
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
    yield* this.state.files.entries()
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
  }
  override get size(): number {
    return this.files.state.dirs.size + (this.has('/fd') ? 1 : 0)
  }
  override has(key: string): boolean {
    return key === '/fd' ? this.files.visibleInputs().size > 0 : this.files.state.dirs.has(key)
  }
  override *[Symbol.iterator](): SetIterator<string> {
    yield* this.files.state.dirs
    if (this.has('/fd')) yield '/fd'
  }
  override add(key: string): this {
    if (key === '/fd' || key.startsWith('/fd/')) throw eacces(`/dev${key}`)
    this.files.state.dirs.add(key)
    return this
  }
  override delete(key: string): boolean {
    if (key === '/fd' || key.startsWith('/fd/')) throw eacces(`/dev${key}`)
    return this.files.state.dirs.delete(key)
  }
}

export class DevStore {
  readonly dirs: Set<string>
  constructor(
    readonly files = new DevFiles(),
    readonly modified = new Map<string, string>(),
    readonly attrs = new Map<string, RAMAttrs>(),
  ) {
    this.dirs = new DevDirs(files)
  }

  forSession(owner: string): DevStore {
    return new DevStore(this.files.forSession(owner), this.modified, this.attrs)
  }
}
