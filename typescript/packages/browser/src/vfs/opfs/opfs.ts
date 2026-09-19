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

import { makeResolveGlob } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import type { FindOptions } from '@struktoai/mirage-core/vfs/base'
import { VFSName } from '@struktoai/mirage-core/types'
import type { FileStat, PathSpec } from '@struktoai/mirage-core/types'
import { lstripSlash } from '@struktoai/mirage-core/utils/slash'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import { OPFSAccessor } from '../../accessor/opfs.ts'
import { OPFS_COMMANDS } from '../../commands/builtin/opfs/index.ts'
import { appendBytes as appendCore } from '../../core/opfs/append.ts'
import { SCOPE_ERROR } from '../../core/opfs/constants.ts'
import { copy as copyCore } from '../../core/opfs/copy.ts'
import { size as duSizeCore } from '../../core/opfs/du/index.ts'
import { exists as existsCore } from '../../core/opfs/exists.ts'
import { find as findCore, type FindOptions as OPFSFindOptions } from '../../core/opfs/find.ts'
import { mkdir as mkdirCore } from '../../core/opfs/mkdir.ts'
import { read as readCoreFn } from '../../core/opfs/read.ts'
import { readdir as readdirCore } from '../../core/opfs/readdir.ts'
import { rename as renameCore } from '../../core/opfs/rename.ts'
import { rmR as rmRCore } from '../../core/opfs/rm.ts'
import { rmdir as rmdirCore } from '../../core/opfs/rmdir.ts'
import { stat as statCore } from '../../core/opfs/stat.ts'
import { stream as streamCore } from '../../core/opfs/stream.ts'
import { truncate as truncateCore } from '../../core/opfs/truncate.ts'
import { unlink as unlinkCore } from '../../core/opfs/unlink.ts'
import { iterEntries, toWritableChunk } from '../../core/opfs/utils.ts'
import { writeBytes as writeCore } from '../../core/opfs/write.ts'
import { OPFS_OPS } from '../../ops/opfs/index.ts'
import { OPFS_PROMPT } from './prompt.ts'

const globCore = makeResolveGlob(readdirCore, SCOPE_ERROR)

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
  readonly name = VFSName.OPFS
  // OPFS is a real filesystem: getFile().size is the exact byte count a
  // read returns.
  override readonly sizesAlwaysKnown: boolean = true
  override readonly prompt = OPFS_PROMPT
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

  override ops(): readonly RegisteredOp[] {
    return OPFS_OPS
  }

  override commands(): readonly RegisteredCommand[] {
    return OPFS_COMMANDS
  }

  override async *streamPath(p: PathSpec): AsyncIterable<Uint8Array> {
    await this.root()
    yield* streamCore(this.accessor, p)
  }

  override async readFile(p: PathSpec): Promise<Uint8Array> {
    await this.root()
    return readCoreFn(this.accessor, p)
  }

  override async writeFile(p: PathSpec, data: Uint8Array): Promise<void> {
    await this.root()
    return writeCore(this.accessor, p, data)
  }

  override async appendFile(p: PathSpec, data: Uint8Array): Promise<void> {
    await this.root()
    return appendCore(this.accessor, p, data)
  }

  override async readdir(p: PathSpec): Promise<string[]> {
    await this.root()
    return readdirCore(this.accessor, p)
  }

  override async stat(p: PathSpec): Promise<FileStat> {
    await this.root()
    return statCore(this.accessor, p)
  }

  override async exists(p: PathSpec): Promise<boolean> {
    await this.root()
    return existsCore(this.accessor, p)
  }

  override async mkdir(p: PathSpec, options?: { recursive?: boolean }): Promise<void> {
    await this.root()
    return mkdirCore(this.accessor, p, options?.recursive === true)
  }

  override async rmdir(p: PathSpec): Promise<void> {
    await this.root()
    return rmdirCore(this.accessor, p)
  }

  override async unlink(p: PathSpec): Promise<void> {
    await this.root()
    return unlinkCore(this.accessor, p)
  }

  override async rename(src: PathSpec, dst: PathSpec): Promise<void> {
    await this.root()
    return renameCore(this.accessor, src, dst)
  }

  override async truncate(p: PathSpec, length: number): Promise<void> {
    await this.root()
    return truncateCore(this.accessor, p, length)
  }

  override async copy(src: PathSpec, dst: PathSpec): Promise<void> {
    await this.root()
    return copyCore(this.accessor, src, dst)
  }

  override async rmR(p: PathSpec): Promise<void> {
    await this.root()
    return rmRCore(this.accessor, p)
  }

  override async du(p: PathSpec): Promise<number> {
    await this.root()
    return duSizeCore(this.accessor, p)
  }

  override async find(p: PathSpec, options: FindOptions = {}): Promise<string[]> {
    await this.root()
    return findCore(this.accessor, p, options as OPFSFindOptions)
  }

  override async glob(paths: readonly PathSpec[]): Promise<PathSpec[]> {
    await this.root()
    return globCore(this.accessor, paths)
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
