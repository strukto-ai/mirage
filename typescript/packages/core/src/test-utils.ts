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

import { RAMIndexCacheStore } from './cache/index/ram.ts'
import type { IndexCacheStore } from './cache/index/store.ts'
import type { OpKwargs } from './ops/types.ts'
import { type FileStat, MountMode, type PathSpec } from './types.ts'
import { BaseVFS } from './vfs/base.ts'
import type { Accessor } from './accessor/base.ts'
import { commandIo } from './commands/builtin/generic_bind/adapter.ts'
import type { CommandIO } from './commands/config.ts'
import { MountEntry } from './workspace/mount/mount.ts'

/**
 * A VFS called the way a mount calls it: through the op door, one index
 * store per instance, so a driver can be exercised without a Workspace. A
 * verb the VFS does not answer is a `no op registered` error, the same
 * answer a mount gives.
 */
class DoorOps {
  readonly index: IndexCacheStore
  private readonly mount: MountEntry

  constructor(readonly vfs: BaseVFS) {
    this.index = new RAMIndexCacheStore({ ttl: vfs.indexTtl })
    this.mount = new MountEntry({ prefix: '/', vfs, mode: MountMode.WRITE })
  }

  /** Whether the door answers `name` on this VFS. */
  has(name: string): boolean {
    return this.mount.hasOp(name)
  }

  /** Call op `name` on `path`; `index` defaults to this instance's store. */
  call(
    name: string,
    path: PathSpec,
    args: readonly unknown[] = [],
    kwargs: OpKwargs = {},
  ): Promise<unknown> {
    return this.mount.callOp(name, path, args, { index: this.index, ...kwargs })
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

const TABLES = new WeakMap<BaseVFS, DoorOps>()

/** The op door of `vfs`, bound once per instance so its index store persists across calls. */
export function ops(vfs: BaseVFS): DoorOps {
  let table = TABLES.get(vfs)
  if (table === undefined) {
    table = new DoorOps(vfs)
    TABLES.set(vfs, table)
  }
  return table
}

type ReadLike = (
  path: PathSpec,
  index?: IndexCacheStore,
  offset?: number,
  size?: number | null,
) => Promise<Uint8Array>

/**
 * Have this one `vfs` render reads of `filetype` with `fn`, which takes
 * `read`'s arguments, window included, as a renderer method does.
 */
export function render<V extends BaseVFS>(vfs: V, filetype: string, fn: ReadLike): V {
  const name = 'render' + filetype.replaceAll('.', '_')
  Object.assign(vfs, { [name]: fn, renderers: { ...vfs.renderers, [filetype]: name } })
  return vfs
}

/**
 * A `cls` VFS over `accessor`, its constructor skipped: the class's functions
 * with the base facts, so a test drives a backend's functions with an
 * accessor of its own. A fact the class declares is not set; pass the ones a
 * test relies on.
 */
export function vfsOver<V extends BaseVFS>(
  cls: { prototype: V },
  accessor: Accessor,
  facts: Partial<Record<keyof V, unknown>> = {},
): V {
  const vfs = new BaseVFS({ accessor })
  Object.setPrototypeOf(vfs, cls.prototype)
  return Object.assign(vfs as V, facts)
}

/** The command table of a `cls` VFS over `accessor`. */
export function ioFor<V extends BaseVFS>(
  cls: { prototype: V },
  accessor: Accessor,
  facts: Partial<Record<keyof V, unknown>> = {},
): CommandIO {
  return commandIo(vfsOver(cls, accessor, facts) as BaseVFS)
}
