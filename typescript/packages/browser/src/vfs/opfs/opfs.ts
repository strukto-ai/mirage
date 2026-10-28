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

import type { ByteSource } from '@struktoai/mirage-core/io/types'
import { BaseVFS, type VFSStateBase } from '@struktoai/mirage-core/vfs/base'
import { VFSName } from '@struktoai/mirage-core/types'
import { lstripSlash } from '@struktoai/mirage-core/utils/slash'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import { OPFSAccessor } from '../../accessor/opfs.ts'
import { iterEntries, toWritableChunk } from '../../core/opfs/utils.ts'
import type { CapacityResult, PathSpec, FileStat } from '@struktoai/mirage-core/types'
import {
  type Charge,
  type StorageUsage,
  charge,
  storageUsage,
} from '@struktoai/mirage-core/vfs/capacity'
import type { Handed } from '@struktoai/mirage-core/vfs/types'
import { readdir as opfsReaddir } from '../../core/opfs/readdir.ts'
import { read as opfsRead } from '../../core/opfs/read.ts'
import { stat as opfsStat } from '../../core/opfs/stat.ts'
import { readStream as opfsStream } from '../../core/opfs/stream.ts'
import { exists as opfsExists } from '../../core/opfs/exists.ts'
import { write as opfsWrite } from '../../core/opfs/write.ts'
import { append as opfsAppend } from '../../core/opfs/append.ts'
import { create as opfsCreate } from '../../core/opfs/create.ts'
import { mkdir as opfsMkdir } from '../../core/opfs/mkdir.ts'
import { unlink as opfsUnlink } from '../../core/opfs/unlink.ts'
import { rmdir as opfsRmdir } from '../../core/opfs/rmdir.ts'
import { rmR as opfsRmR } from '../../core/opfs/rm.ts'
import { rename as opfsRename } from '../../core/opfs/rename.ts'
import { copy as opfsCopy } from '../../core/opfs/copy.ts'
import { truncate as opfsTruncate } from '../../core/opfs/truncate.ts'
import { count as opfsCount, sizeOf as opfsSizeOf } from '../../core/opfs/capacity.ts'
import { LOCAL_WALK_LIMIT } from '@struktoai/mirage-core/vfs/constants'

export interface OPFSVFSOptions {
  root?: string
  // The most bytes the root may hold: a size like `100MB` or a count of
  // bytes. Counted at the first write or `df`.
  capacity?: number | string | null
}

export interface OPFSVFSState {
  type: string
  config?: { capacity?: number }
  files: Record<string, Uint8Array>
  dirs: string[]
}

async function walkFiles(
  dir: FileSystemDirectoryHandle,
  currentPath: string,
  files: Record<string, Uint8Array>,
): Promise<void> {
  for await (const [name, handle] of iterEntries(dir)) {
    const childPath = currentPath === '' ? name : `${currentPath}/${name}`
    if (handle.kind === 'file') {
      const fh = await dir.getFileHandle(name, { create: false })
      const file = await fh.getFile()
      files[childPath] = new Uint8Array(await file.arrayBuffer())
    } else {
      const child = await dir.getDirectoryHandle(name, { create: false })
      await walkFiles(child, childPath, files)
    }
  }
}

async function walkDirs(
  dir: FileSystemDirectoryHandle,
  currentPath: string,
  dirs: string[],
): Promise<void> {
  for await (const [name, handle] of iterEntries(dir)) {
    if (handle.kind !== 'directory') continue
    const childPath = currentPath === '' ? `/${name}` : `${currentPath}/${name}`
    dirs.push(childPath)
    const child = await dir.getDirectoryHandle(name, { create: false })
    await walkDirs(child, childPath, dirs)
  }
}

async function splitAndCreate(
  root: FileSystemDirectoryHandle,
  relativePath: string,
): Promise<FileSystemDirectoryHandle> {
  let handle = root
  for (const seg of relativePath.split('/')) {
    if (seg === '' || seg === '.') continue
    handle = await handle.getDirectoryHandle(seg, { create: true })
  }
  return handle
}

export class OPFSVFS extends BaseVFS {
  override readonly name = VFSName.OPFS
  // OPFS is a real filesystem: getFile().size is the exact byte count a
  // read returns.
  override readonly sizesAlwaysKnown: boolean = true
  readonly rootName: string
  override readonly accessor: OPFSAccessor
  override readonly usage: StorageUsage | null
  private rootHandle: FileSystemDirectoryHandle | null = null
  private openPromise: Promise<FileSystemDirectoryHandle> | null = null

  override walkLimit: number = LOCAL_WALK_LIMIT

  constructor(options: OPFSVFSOptions = {}) {
    super()
    this.rootName = options.root ?? ''
    this.accessor = new OPFSAccessor(this)
    this.usage = storageUsage(this.name, options.capacity)
  }

  private charge<T>(path: PathSpec, write: (held: Charge) => Promise<T>): Promise<T> {
    return charge(
      this.usage,
      path,
      (p) => opfsSizeOf(this.accessor, p),
      () => opfsCount(this.accessor),
      write,
    )
  }

  /** df's QUOTA row for a capped root, counted afresh so another tab's
   * writes show; the base answer otherwise. */
  override async capacity(): Promise<CapacityResult> {
    if (this.usage === null) return super.capacity()
    this.usage.stale()
    await this.usage.counted(() => opfsCount(this.accessor))
    return this.usage.report()
  }
  override async close(): Promise<void> {
    this.rootHandle = null
    this.openPromise = null
    await super.close()
  }

  /**
   * Lazily resolve to a usable root handle. Memoizes `navigator.storage`
   * traversal so the VFS self-initializes on the first op, the way the
   * node redis store connects on its first command.
   */
  root(): Promise<FileSystemDirectoryHandle> {
    if (this.rootHandle !== null) return Promise.resolve(this.rootHandle)
    this.openPromise ??= (async () => {
      const origin = await navigator.storage.getDirectory()
      let handle = origin
      for (const seg of this.rootName.split('/')) {
        if (seg === '' || seg === '.') continue
        handle = await handle.getDirectoryHandle(seg, { create: true })
      }
      this.rootHandle = handle
      return handle
    })()
    return this.openPromise
  }

  override readonly readsRanges: boolean = true

  override readonly local: boolean = true

  override readdir(path: PathSpec): Promise<FileStat[]> {
    return opfsReaddir(this.accessor, path)
  }

  override read(
    path: PathSpec,
    _handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<ByteSource> | AsyncIterable<Uint8Array> {
    if (offset === 0 && size === null) return opfsStream(this.accessor, path)
    return opfsRead(this.accessor, path, size === null ? { offset } : { offset, size })
  }

  override stat(path: PathSpec): Promise<FileStat> {
    return opfsStat(this.accessor, path)
  }

  override exists(path: PathSpec): Promise<boolean> {
    return opfsExists(this.accessor, path)
  }

  override write(path: PathSpec, data: ByteSource, signal?: AbortSignal): Promise<void> {
    return this.charge(path, (held) => opfsWrite(this.accessor, path, held.stream(data), signal))
  }

  override append(
    path: PathSpec,
    data: ByteSource,
    _handed?: Handed,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.charge(path, (held) =>
      opfsAppend(this.accessor, path, held.stream(data, true), signal),
    )
  }

  override create(path: PathSpec): Promise<void> {
    return this.charge(path, () => opfsCreate(this.accessor, path))
  }

  override mkdir(path: PathSpec, parents = false): Promise<void> {
    return opfsMkdir(this.accessor, path, parents)
  }

  override unlink(path: PathSpec): Promise<void> {
    return this.charge(path, () => opfsUnlink(this.accessor, path))
  }

  override rmdir(path: PathSpec): Promise<void> {
    return opfsRmdir(this.accessor, path)
  }

  override rmR(path: PathSpec): Promise<void> {
    return this.charge(path, () => opfsRmR(this.accessor, path))
  }

  override rename(src: PathSpec, dst: PathSpec): Promise<void> {
    return this.charge(src, () => this.charge(dst, () => opfsRename(this.accessor, src, dst)))
  }

  override copy(src: PathSpec, dst: PathSpec): Promise<void> {
    return this.charge(dst, async (held) => {
      if (this.usage !== null) held.growTo(await opfsSizeOf(this.accessor, src))
      await opfsCopy(this.accessor, src, dst)
    })
  }

  override truncate(path: PathSpec, length: number, noCreate = false): Promise<void> {
    return this.charge(path, async (held) => {
      if (!noCreate || (await this.exists(path))) held.growTo(length)
      await opfsTruncate(this.accessor, path, length, noCreate)
    })
  }

  override async getState(): Promise<OPFSVFSState> {
    const handle = await this.root()
    const files: Record<string, Uint8Array> = {}
    await walkFiles(handle, '', files)
    const dirs: string[] = []
    await walkDirs(handle, '', dirs)
    dirs.sort(compareCodePoints)
    return {
      type: this.name,
      ...(this.usage !== null ? { config: { capacity: this.usage.limit } } : {}),
      files,
      dirs,
    }
  }

  override async loadState(state: VFSStateBase & Partial<OPFSVFSState>): Promise<void> {
    const handle = await this.root()
    for (const dir of state.dirs ?? []) {
      const rel = lstripSlash(dir)
      if (rel === '') continue
      await splitAndCreate(handle, rel)
    }
    for (const [rel, data] of Object.entries(state.files ?? {})) {
      const segs = rel.split('/').filter((s) => s !== '' && s !== '.')
      const fileName = segs.pop()
      if (fileName === undefined) continue
      let dir = handle
      for (const seg of segs) {
        dir = await dir.getDirectoryHandle(seg, { create: true })
      }
      const fh = await dir.getFileHandle(fileName, { create: true })
      const writable = await fh.createWritable()
      await writable.write(toWritableChunk(data))
      await writable.close()
    }
    this.usage?.stale()
  }
}
