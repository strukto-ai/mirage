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

import { NOOPAccessor } from './accessor/base.ts'
import { RAMIndexCacheStore } from './cache/index/ram.ts'
import type { IndexCacheStore } from './cache/index/store.ts'
import type { OpKwargs, RegisteredOp } from './ops/registry.ts'
import type { FileStat, PathSpec } from './types.ts'
import type { BaseVFS } from './vfs/base.ts'

const NOOP_ACCESSOR = new NOOPAccessor()

/**
 * A driver's op table, callable the way a mount calls it: the accessor
 * bound, one index store per driver, the mount's argument conventions.
 * Test-only. A verb the table does not carry is a `no op registered`
 * error, the same answer a mount gives; a test that needs a core
 * function the table has no op for calls that function with
 * `vfs.accessor` directly.
 */
export class DriverOps {
  readonly index: IndexCacheStore

  constructor(
    readonly vfs: BaseVFS,
    index?: IndexCacheStore,
  ) {
    this.index = index ?? new RAMIndexCacheStore({ ttl: vfs.indexTtl })
  }

  op(name: string): RegisteredOp {
    const op = this.vfs.ops().find((o) => o.name === name && o.filetype === null)
    if (op === undefined) throw new Error(`no op registered: ${name} for VFS ${this.vfs.name}`)
    return op
  }

  has(name: string): boolean {
    return this.vfs.ops().some((o) => o.name === name && o.filetype === null)
  }

  call(
    name: string,
    path: PathSpec,
    args: readonly unknown[] = [],
    kwargs: OpKwargs = {},
  ): Promise<unknown> {
    const accessor = this.vfs.accessor ?? NOOP_ACCESSOR
    return Promise.resolve(this.op(name).fn(accessor, path, args, { index: this.index, ...kwargs }))
  }

  read(path: PathSpec, kwargs: OpKwargs = {}): Promise<Uint8Array> {
    return this.call('read', path, [], kwargs) as Promise<Uint8Array>
  }

  readdir(path: PathSpec): Promise<string[]> {
    return this.call('readdir', path) as Promise<string[]>
  }

  stat(path: PathSpec): Promise<FileStat> {
    return this.call('stat', path) as Promise<FileStat>
  }

  glob(path: PathSpec): Promise<PathSpec[]> {
    return this.call('glob', path) as Promise<PathSpec[]>
  }

  async write(path: PathSpec, data: Uint8Array): Promise<void> {
    await this.call('write', path, [data])
  }

  async append(path: PathSpec, data: Uint8Array): Promise<void> {
    await this.call('append', path, [data])
  }

  async create(path: PathSpec): Promise<void> {
    await this.call('create', path)
  }

  async mkdir(path: PathSpec, parents = false): Promise<void> {
    await this.call('mkdir', path, [], parents ? { parents: true } : {})
  }

  async unlink(path: PathSpec): Promise<void> {
    await this.call('unlink', path)
  }

  async rmdir(path: PathSpec): Promise<void> {
    await this.call('rmdir', path)
  }

  async rename(src: PathSpec, dst: PathSpec): Promise<void> {
    await this.call('rename', src, [dst], { dst })
  }

  async truncate(path: PathSpec, length: number): Promise<void> {
    await this.call('truncate', path, [length])
  }
}

const TABLES = new WeakMap<BaseVFS, DriverOps>()

/** The op table of `vfs`, bound once per instance so its index store persists across calls. */
export function ops(vfs: BaseVFS): DriverOps {
  let table = TABLES.get(vfs)
  if (table === undefined) {
    table = new DriverOps(vfs)
    TABLES.set(vfs, table)
  }
  return table
}
