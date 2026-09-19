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

import { mkdirSync } from 'node:fs'
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  stat as fsStat,
  statfs as fsStatfs,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { makeResolveGlob } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import type { FindOptions } from '@struktoai/mirage-core/vfs/base'
import { CapacityState, PathSpec, VFSName } from '@struktoai/mirage-core/types'
import type { CapacityResult, FileStat } from '@struktoai/mirage-core/types'
import { mountKey, mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import { DISK_COMMANDS } from '../../commands/builtin/disk/index.ts'
import { appendBytes as appendCore } from '../../core/disk/append.ts'
import { SCOPE_ERROR } from '../../core/disk/constants.ts'
import { copy as copyCore } from '../../core/disk/copy.ts'
import { size as duSizeCore } from '../../core/disk/du/index.ts'
import { exists as existsCore } from '../../core/disk/exists.ts'
import { find as findCore, type FindOptions as DiskFindOptions } from '../../core/disk/find.ts'
import { mkdir as mkdirCore } from '../../core/disk/mkdir.ts'
import { read as readCoreFn } from '../../core/disk/read.ts'
import { readdir as readdirCore } from '../../core/disk/readdir.ts'
import { rename as renameCore } from '../../core/disk/rename.ts'
import { rmR as rmRCore } from '../../core/disk/rm.ts'
import { rmdir as rmdirCore } from '../../core/disk/rmdir.ts'
import { stat as statCore } from '../../core/disk/stat.ts'
import { stream as streamCore } from '../../core/disk/stream.ts'
import { truncate as truncateCore } from '../../core/disk/truncate.ts'
import { unlink as unlinkCore } from '../../core/disk/unlink.ts'
import { writeBytes as writeCore } from '../../core/disk/write.ts'
import { DiskAccessor } from '../../accessor/disk.ts'
import { DISK_OPS } from '../../ops/disk/index.ts'
import { DISK_PROMPT } from './prompt.ts'
import { type DeltaHook } from '@struktoai/mirage-core/watch/index'
import { buildDeltaHook } from '../../core/disk/watch/index.ts'

const globCore = makeResolveGlob(readdirCore, SCOPE_ERROR)

export interface DiskVFSOptions {
  root: string
}

export interface DiskVFSState {
  type: string
  files: Record<string, Uint8Array>
  modes?: Record<string, number>
}

async function walkFiles(root: string, current: string, out: string[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true })
  for (const e of entries) {
    const child = path.join(current, e.name)
    if (e.isDirectory()) {
      await walkFiles(root, child, out)
    } else if (e.isFile()) {
      out.push(child)
    }
  }
}

export class DiskVFS extends BaseVFS {
  readonly name = VFSName.DISK
  override readonly cachesReads: boolean = false
  // byte store: stat() sizes every file from metadata
  override readonly sizesAlwaysKnown: boolean = true
  override readonly indexTtl: number = 60
  override readonly prompt = DISK_PROMPT
  readonly root: string
  override readonly accessor: DiskAccessor
  constructor(options: DiskVFSOptions) {
    super()
    this.root = path.resolve(options.root)
    mkdirSync(this.root, { recursive: true })
    this.accessor = new DiskAccessor(this.root)
  }

  // The resolved root is the storage: two DiskVFS instances built on the same
  // directory are one store, however they were spelled.
  override storageId(): string {
    return `${this.name}:${this.root}`
  }
  // A real filesystem reports real numbers (QUOTA). GNU df: used counts
  // reserved blocks (blocks - bfree), available excludes them (bavail).
  override async statfs(): Promise<CapacityResult> {
    const st = await fsStatfs(this.root)
    const bsize = st.bsize
    return {
      state: CapacityState.QUOTA,
      total: st.blocks * bsize,
      used: (st.blocks - st.bfree) * bsize,
      available: st.bavail * bsize,
      inodes: st.files,
      inodesUsed: st.files - st.ffree,
      inodesFree: st.ffree,
    }
  }

  override ops(): readonly RegisteredOp[] {
    return DISK_OPS
  }

  override commands(): readonly RegisteredCommand[] {
    return DISK_COMMANDS
  }

  override streamPath(p: PathSpec): AsyncIterable<Uint8Array> {
    return streamCore(this.accessor, p)
  }

  override readFile(p: PathSpec): Promise<Uint8Array> {
    return readCoreFn(this.accessor, p)
  }

  override writeFile(p: PathSpec, data: Uint8Array): Promise<void> {
    return writeCore(this.accessor, p, data)
  }

  override appendFile(p: PathSpec, data: Uint8Array): Promise<void> {
    return appendCore(this.accessor, p, data)
  }

  override readdir(p: PathSpec): Promise<string[]> {
    return readdirCore(this.accessor, p, this.index)
  }

  override stat(p: PathSpec): Promise<FileStat> {
    return statCore(this.accessor, p)
  }

  override exists(p: PathSpec): Promise<boolean> {
    return existsCore(this.accessor, p)
  }

  override mkdir(p: PathSpec, options?: { recursive?: boolean }): Promise<void> {
    return mkdirCore(this.accessor, p, options?.recursive === true)
  }

  override rmdir(p: PathSpec): Promise<void> {
    return rmdirCore(this.accessor, p)
  }

  override unlink(p: PathSpec): Promise<void> {
    return unlinkCore(this.accessor, p)
  }

  override rename(src: PathSpec, dst: PathSpec): Promise<void> {
    return renameCore(this.accessor, src, dst)
  }

  override truncate(p: PathSpec, length: number): Promise<void> {
    return truncateCore(this.accessor, p, length)
  }

  override copy(src: PathSpec, dst: PathSpec): Promise<void> {
    return copyCore(this.accessor, src, dst)
  }

  override rmR(p: PathSpec): Promise<void> {
    return rmRCore(this.accessor, p)
  }

  override du(p: PathSpec): Promise<number> {
    return duSizeCore(this.accessor, p)
  }

  override find(p: PathSpec, options: FindOptions = {}): Promise<string[]> {
    return findCore(this.accessor, p, options as DiskFindOptions)
  }

  override deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override glob(paths: readonly PathSpec[], prefix = ''): Promise<PathSpec[]> {
    const effective = prefix
      ? paths.map((p) =>
          mountPrefixOf(p.virtual, p.vfsPath)
            ? p
            : new PathSpec({
                virtual: p.virtual,
                directory: p.directory,
                ...(p.pattern !== null ? { pattern: p.pattern } : {}),
                resolved: p.resolved,
                vfsPath: mountKey(p.virtual, prefix),
              }),
        )
      : paths
    return globCore(this.accessor, effective, this.index)
  }

  override async getState(): Promise<DiskVFSState> {
    await mkdir(this.root, { recursive: true })
    const files: Record<string, Uint8Array> = {}
    const modes: Record<string, number> = {}
    const fileList: string[] = []
    await walkFiles(this.root, this.root, fileList)
    for (const full of fileList) {
      const rel = path.relative(this.root, full).split(path.sep).join('/')
      const data = await readFile(full)
      files[rel] = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      // Capture the real inode mode: it is the base truth for disk
      // permissions (the sidecar is gone), so restore must reapply it or
      // a chmod would reset to the host umask.
      modes[rel] = (await fsStat(full)).mode & 0o7777
    }
    return {
      type: this.name,
      files,
      modes,
    }
  }

  override async loadState(state: DiskVFSState): Promise<void> {
    await mkdir(this.root, { recursive: true })
    for (const [rel, data] of Object.entries(state.files)) {
      const full = path.join(this.root, rel)
      await mkdir(path.dirname(full), { recursive: true })
      await writeFile(full, data)
      const mode = state.modes?.[rel]
      if (mode !== undefined) await chmod(full, mode)
    }
  }
}
