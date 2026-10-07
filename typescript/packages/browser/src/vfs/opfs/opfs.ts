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

import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { VFSName } from '@struktoai/mirage-core/types'
import { lstripSlash } from '@struktoai/mirage-core/utils/slash'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import { OPFSAccessor } from '../../accessor/opfs.ts'
import { iterEntries, toWritableChunk } from '../../core/opfs/utils.ts'
import { PROMPT } from './prompt.ts'
import type { PathSpec, FileStat } from '@struktoai/mirage-core/types'
import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import type { FindOptions } from '@struktoai/mirage-core/vfs/base'
import type { DuEntries } from '@struktoai/mirage-core/vfs/types'
import { readdir as opfsReaddir } from '../../core/opfs/readdir.ts'
import { read as opfsRead } from '../../core/opfs/read.ts'
import { stat as opfsStat } from '../../core/opfs/stat.ts'
import { readStream as opfsStream } from '../../core/opfs/stream.ts'
import { exists as opfsExists } from '../../core/opfs/exists.ts'
import { find as opfsFind } from '../../core/opfs/find.ts'
import { size as opfsDu, entries as opfsDuAll } from '../../core/opfs/du/index.ts'
import { write as opfsWrite } from '../../core/opfs/write.ts'
import { appendBytes as opfsAppend } from '../../core/opfs/append.ts'
import { create as opfsCreate } from '../../core/opfs/create.ts'
import { mkdir as opfsMkdir } from '../../core/opfs/mkdir.ts'
import { unlink as opfsUnlink } from '../../core/opfs/unlink.ts'
import { rmdir as opfsRmdir } from '../../core/opfs/rmdir.ts'
import { rmR as opfsRmR } from '../../core/opfs/rm.ts'
import { rename as opfsRename } from '../../core/opfs/rename.ts'
import { copy as opfsCopy } from '../../core/opfs/copy.ts'
import { truncate as opfsTruncate } from '../../core/opfs/truncate.ts'
import { SCOPE_ERROR } from '../../core/opfs/constants.ts'
export interface OPFSVFSOptions {
  root?: string
}

export interface OPFSVFSState {
  type: string
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
  override readonly prompt = PROMPT
  readonly rootName: string
  override readonly accessor: OPFSAccessor
  private rootHandle: FileSystemDirectoryHandle | null = null
  private openPromise: Promise<FileSystemDirectoryHandle> | null = null

  constructor(options: OPFSVFSOptions = {}) {
    super()
    this.rootName = options.root ?? ''
    this.accessor = new OPFSAccessor(this)
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

  override readonly maxGlobMatches: number = SCOPE_ERROR

  override readdir(path: PathSpec, _index?: IndexCacheStore): Promise<string[]> {
    return opfsReaddir(this.accessor, path)
  }

  override read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    if (offset === 0 && size === null) return opfsRead(this.accessor, path, index)
    return opfsRead(this.accessor, path, index, size === null ? { offset } : { offset, size })
  }

  override stat(path: PathSpec, _index?: IndexCacheStore): Promise<FileStat> {
    return opfsStat(this.accessor, path)
  }

  override readStream(path: PathSpec, _index?: IndexCacheStore): AsyncIterable<Uint8Array> {
    return opfsStream(this.accessor, path)
  }

  override exists(path: PathSpec): Promise<boolean> {
    return opfsExists(this.accessor, path)
  }

  override find(path: PathSpec, options: FindOptions, _index?: IndexCacheStore): Promise<string[]> {
    return opfsFind(this.accessor, path, options)
  }

  override duSize(path: PathSpec, _index?: IndexCacheStore): Promise<number> {
    return opfsDu(this.accessor, path)
  }

  override duEntries(path: PathSpec, _index?: IndexCacheStore): Promise<DuEntries> {
    return opfsDuAll(this.accessor, path)
  }

  override write(path: PathSpec, data: Uint8Array): Promise<void> {
    return opfsWrite(this.accessor, path, data)
  }

  override append(path: PathSpec, data: Uint8Array): Promise<void> {
    return opfsAppend(this.accessor, path, data)
  }

  override create(path: PathSpec): Promise<void> {
    return opfsCreate(this.accessor, path)
  }

  override mkdir(path: PathSpec, parents = false): Promise<void> {
    return opfsMkdir(this.accessor, path, parents)
  }

  override unlink(path: PathSpec): Promise<void> {
    return opfsUnlink(this.accessor, path)
  }

  override rmdir(path: PathSpec, _index?: IndexCacheStore): Promise<void> {
    return opfsRmdir(this.accessor, path)
  }

  override rmR(path: PathSpec): Promise<void> {
    return opfsRmR(this.accessor, path)
  }

  override rename(src: PathSpec, dst: PathSpec): Promise<void> {
    return opfsRename(this.accessor, src, dst)
  }

  override copy(src: PathSpec, dst: PathSpec): Promise<void> {
    return opfsCopy(this.accessor, src, dst)
  }

  override truncate(path: PathSpec, length: number, noCreate = false): Promise<void> {
    return opfsTruncate(this.accessor, path, length, noCreate)
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
      files,
      dirs,
    }
  }

  override async loadState(state: OPFSVFSState): Promise<void> {
    const handle = await this.root()
    for (const dir of state.dirs) {
      const rel = lstripSlash(dir)
      if (rel === '') continue
      await splitAndCreate(handle, rel)
    }
    for (const [rel, data] of Object.entries(state.files)) {
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
  }
}
