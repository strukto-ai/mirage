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

import {
  type FileStat,
  type FindOptions,
  type PathSpec,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
  ResourceName,
  lstripSlash,
  makeResolveGlob,
} from '@struktoai/mirage-core'
import { OPFSAccessor } from '../../accessor/opfs.ts'
import { OPFS_COMMANDS } from '../../commands/builtin/opfs/index.ts'
import { appendBytes as appendCore } from '../../core/opfs/append.ts'
import { SCOPE_ERROR } from '../../core/opfs/constants.ts'
import { copy as copyCore } from '../../core/opfs/copy.ts'
import { du as duCore } from '../../core/opfs/du.ts'
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

export interface OPFSResourceOptions {
  root?: string
}

export interface OPFSResourceState {
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

export class OPFSResource implements Resource {
  readonly kind = ResourceName.OPFS
  readonly prompt = OPFS_PROMPT
  readonly rootName: string
  readonly accessor: OPFSAccessor
  private rootHandle: FileSystemDirectoryHandle | null = null
  private openPromise: Promise<FileSystemDirectoryHandle> | null = null

  constructor(options: OPFSResourceOptions = {}) {
    this.rootName = options.root ?? ''
    this.accessor = new OPFSAccessor(this)
  }

  open(): Promise<void> {
    return this.ensureOpen().then(() => undefined)
  }

  close(): Promise<void> {
    this.rootHandle = null
    this.openPromise = null
    return Promise.resolve()
  }

  /**
   * Lazily resolve to a usable root handle. Memoizes `navigator.storage`
   * traversal so the resource self-initializes on first method call without
   * relying on an external orchestrator.
   */
  private ensureOpen(): Promise<FileSystemDirectoryHandle> {
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

  requireHandle(): FileSystemDirectoryHandle {
    if (this.rootHandle === null) {
      throw new Error('OPFSResource is not open — call open() first')
    }
    return this.rootHandle
  }

  ops(): readonly RegisteredOp[] {
    return OPFS_OPS
  }

  commands(): readonly RegisteredCommand[] {
    return OPFS_COMMANDS
  }

  async *streamPath(p: PathSpec): AsyncIterable<Uint8Array> {
    await this.ensureOpen()
    yield* streamCore(this.accessor, p)
  }

  async readFile(p: PathSpec): Promise<Uint8Array> {
    await this.ensureOpen()
    return readCoreFn(this.accessor, p)
  }

  async writeFile(p: PathSpec, data: Uint8Array): Promise<void> {
    await this.ensureOpen()
    return writeCore(this.accessor, p, data)
  }

  async appendFile(p: PathSpec, data: Uint8Array): Promise<void> {
    await this.ensureOpen()
    return appendCore(this.accessor, p, data)
  }

  async readdir(p: PathSpec): Promise<string[]> {
    await this.ensureOpen()
    return readdirCore(this.accessor, p)
  }

  async stat(p: PathSpec): Promise<FileStat> {
    await this.ensureOpen()
    return statCore(this.accessor, p)
  }

  async exists(p: PathSpec): Promise<boolean> {
    await this.ensureOpen()
    return existsCore(this.accessor, p)
  }

  async mkdir(p: PathSpec, options?: { recursive?: boolean }): Promise<void> {
    await this.ensureOpen()
    return mkdirCore(this.accessor, p, options?.recursive === true)
  }

  async rmdir(p: PathSpec): Promise<void> {
    await this.ensureOpen()
    return rmdirCore(this.accessor, p)
  }

  async unlink(p: PathSpec): Promise<void> {
    await this.ensureOpen()
    return unlinkCore(this.accessor, p)
  }

  async rename(src: PathSpec, dst: PathSpec): Promise<void> {
    await this.ensureOpen()
    return renameCore(this.accessor, src, dst)
  }

  async truncate(p: PathSpec, length: number): Promise<void> {
    await this.ensureOpen()
    return truncateCore(this.accessor, p, length)
  }

  async copy(src: PathSpec, dst: PathSpec): Promise<void> {
    await this.ensureOpen()
    return copyCore(this.accessor, src, dst)
  }

  async rmR(p: PathSpec): Promise<void> {
    await this.ensureOpen()
    return rmRCore(this.accessor, p)
  }

  async du(p: PathSpec): Promise<number> {
    await this.ensureOpen()
    return duCore(this.accessor, p)
  }

  async find(p: PathSpec, options: FindOptions = {}): Promise<string[]> {
    await this.ensureOpen()
    return findCore(this.accessor, p, options as OPFSFindOptions)
  }

  async glob(paths: readonly PathSpec[]): Promise<PathSpec[]> {
    await this.ensureOpen()
    return globCore(this.accessor, paths)
  }

  async getState(): Promise<OPFSResourceState> {
    const handle = await this.ensureOpen()
    const files: Record<string, Uint8Array> = {}
    await walkFiles(handle, '', files)
    const dirs: string[] = []
    await walkDirs(handle, '', dirs)
    dirs.sort()
    return {
      type: this.kind,
      files,
      dirs,
    }
  }

  async loadState(state: OPFSResourceState): Promise<void> {
    const handle = await this.ensureOpen()
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
