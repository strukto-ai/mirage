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
import type { OpKwargs } from './view/types.ts'
import type { WriteContext } from './cache/types.ts'
import { type FileStat, MountMode, type PathSpec } from './types.ts'
import { BaseVFS } from './vfs/base.ts'
import type { Accessor } from './accessor/base.ts'
import { commandIo } from './commands/builtin/generic_bind/adapter.ts'
import type { CommandIO } from './commands/config.ts'
import { MountEntry } from './workspace/mount/mount.ts'
import { sha256Hex } from './utils/hash.ts'
import {
  EUC_CN,
  EUC_JP,
  EUC_KR,
  GB18030,
  GBK,
  SJIS,
  type MultibyteSpec,
  multibyteReverse,
  multibyteTable,
} from './commands/builtin/generic/iconv_multibyte.ts'

// Shared by the Node tests and the Chrome suite, with the same digests in
// Python. Every entry was checked against glibc 2.41 on debian:stable-slim,
// both directions; the host decoder only seeds these normalized tables.
export const ICONV_MULTIBYTE_DIGESTS: [MultibyteSpec, number, string, number, string][] = [
  [GBK, 21791, 'bba66856a1a44bdc', 21920, '4013fbd0c747f579'],
  [EUC_CN, 7445, 'e73a16723240a945', 7573, 'acabc939aa1cb893'],
  [GB18030, 63360, '995fabe77efceaa4', 63488, '56a3c65aa0c1b946'],
  [EUC_KR, 8227, 'f1f8fe46cc836ea0', 8388, '96d8b6b82ea1a6de'],
  [SJIS, 6879, '9e31ef626b7726f0', 7075, '152ab23536e0befb'],
  [EUC_JP, 13009, '0a3c10912de393e1', 13169, 'af425d9e826f2b95'],
]

async function iconvTableDigest(
  entries: Iterable<[number, number]>,
  width: number,
): Promise<string> {
  const text = [...entries]
    .sort((a, b) => a[0] - b[0])
    .map(([k, v]) => `${k.toString(16)}:${v.toString(16).padStart(width, '0')}\n`)
    .join('')
  return (await sha256Hex(new TextEncoder().encode(text))).slice(0, 16)
}

/** The decode and reverse table sizes and digests for one iconv charset. */
export async function iconvMultibyteDigests(
  spec: MultibyteSpec,
): Promise<[number, string, number, string]> {
  const table = multibyteTable(spec)
  const reverse = multibyteReverse(spec)
  return [
    table.size,
    await iconvTableDigest(table, 1),
    reverse.size,
    await iconvTableDigest(reverse, 2),
  ]
}

/**
 * A VFS called the way a mount calls it: through the dispatcher, one index
 * store per instance, so a driver can be exercised without a Workspace. A
 * verb the VFS does not answer is a `no op registered` error, the same
 * answer a mount gives.
 */
class MountedVFS {
  readonly index: IndexCacheStore
  private readonly mount: MountEntry

  constructor(readonly vfs: BaseVFS) {
    this.index = new RAMIndexCacheStore({ ttl: vfs.indexTtl })
    this.mount = new MountEntry({ prefix: '/', vfs, mode: MountMode.WRITE })
  }

  /** Whether the dispatcher answers `name` on this VFS. */
  has(name: string): boolean {
    return this.mount.answers(name)
  }

  /** Call op `name` on `path`; `index` defaults to this instance's store. */
  call(
    name: string,
    path: PathSpec,
    args: readonly unknown[] = [],
    kwargs: OpKwargs = {},
  ): Promise<unknown> {
    return this.mount.callKeyed(name, path, args, { index: this.index, ...kwargs })
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
    await this.call('rename', src, [dst])
  }

  async truncate(path: PathSpec, length: number): Promise<void> {
    await this.call('truncate', path, [length])
  }
}

const TABLES = new WeakMap<BaseVFS, MountedVFS>()

/** The dispatcher of `vfs`, bound once per instance so its index store persists across calls. */
export function ops(vfs: BaseVFS): MountedVFS {
  let table = TABLES.get(vfs)
  if (table === undefined) {
    table = new MountedVFS(vfs)
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

/**
 * A write context whose store holds `s0` and records what it keeps, for a
 * refusal test where the store's version, the write's and the one sent all
 * differ. Mirrors Python's `tests/fixtures/write_context.KeptVersions`.
 */
export function keptVersions(vfs: string): { context: WriteContext; kept: string[] } {
  const kept: string[] = []
  const context: WriteContext = {
    vfs,
    conditions: ['put', 'copy', 'delete'],
    readVersion: () => Promise.resolve('s0'),
    readVersions: (paths) => Promise.resolve(paths.map(() => 's0')),
    drop: () => Promise.resolve(),
    keep: (_path, version) => {
      kept.push(version)
      return Promise.resolve()
    },
  }
  return { context, kept }
}
