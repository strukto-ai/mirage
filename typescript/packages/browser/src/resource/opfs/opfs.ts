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
} from '@struktoai/mirage-core'
import { OPFSAccessor } from '../../accessor/opfs.ts'
import { OPFS_COMMANDS } from '../../commands/builtin/opfs/index.ts'
import { appendBytes as appendCore } from '../../core/opfs/append.ts'
import { copy as copyCore } from '../../core/opfs/copy.ts'
import { du as duCore } from '../../core/opfs/du.ts'
import { exists as existsCore } from '../../core/opfs/exists.ts'
import { find as findCore, type FindOptions as OPFSFindOptions } from '../../core/opfs/find.ts'
import { resolveGlob as globCore } from '../../core/opfs/glob.ts'
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
    yield* streamCore(await this.ensureOpen(), p)
  }

  async readFile(p: PathSpec): Promise<Uint8Array> {
    return readCoreFn(await this.ensureOpen(), p)
  }

  async writeFile(p: PathSpec, data: Uint8Array): Promise<void> {
    return writeCore(await this.ensureOpen(), p, data)
  }

  async appendFile(p: PathSpec, data: Uint8Array): Promise<void> {
    return appendCore(await this.ensureOpen(), p, data)
  }

  async readdir(p: PathSpec): Promise<string[]> {
    return readdirCore(await this.ensureOpen(), p)
  }

  async stat(p: PathSpec): Promise<FileStat> {
    return statCore(await this.ensureOpen(), p)
  }

  async exists(p: PathSpec): Promise<boolean> {
    return existsCore(await this.ensureOpen(), p)
  }

  async mkdir(p: PathSpec, options?: { recursive?: boolean }): Promise<void> {
    return mkdirCore(await this.ensureOpen(), p, options?.recursive === true)
  }

  async rmdir(p: PathSpec): Promise<void> {
    return rmdirCore(await this.ensureOpen(), p)
  }

  async unlink(p: PathSpec): Promise<void> {
    return unlinkCore(await this.ensureOpen(), p)
  }

  async rename(src: PathSpec, dst: PathSpec): Promise<void> {
    return renameCore(await this.ensureOpen(), src, dst)
  }

  async truncate(p: PathSpec, length: number): Promise<void> {
    return truncateCore(await this.ensureOpen(), p, length)
  }

  async copy(src: PathSpec, dst: PathSpec): Promise<void> {
    return copyCore(await this.ensureOpen(), src, dst)
  }

  async rmR(p: PathSpec): Promise<void> {
    return rmRCore(await this.ensureOpen(), p)
  }

  async du(p: PathSpec): Promise<number> {
    return duCore(await this.ensureOpen(), p)
  }

  async find(p: PathSpec, options: FindOptions = {}): Promise<string[]> {
    return findCore(await this.ensureOpen(), p, options as OPFSFindOptions)
  }

  async glob(paths: readonly PathSpec[]): Promise<PathSpec[]> {
    return globCore(await this.ensureOpen(), paths)
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
      const rel = dir.replace(/^\/+/, '')
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
