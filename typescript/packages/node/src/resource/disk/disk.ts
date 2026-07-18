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

import { chmod, mkdir, readdir, readFile, stat as fsStat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  BaseResource,
  PathSpec,
  ResourceName,
  mountKey,
  mountPrefixOf,
  type FileStat,
  type FindOptions,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
} from '@struktoai/mirage-core'
import { DISK_COMMANDS } from '../../commands/builtin/disk/index.ts'
import { appendBytes as appendCore } from '../../core/disk/append.ts'
import { copy as copyCore } from '../../core/disk/copy.ts'
import { create as createCore } from '../../core/disk/create.ts'
import { du as duCore, duAll as duAllCore } from '../../core/disk/du.ts'
import { exists as existsCore } from '../../core/disk/exists.ts'
import { find as findCore, type FindOptions as DiskFindOptions } from '../../core/disk/find.ts'
import { resolveGlob as globCore } from '../../core/disk/glob.ts'
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

export interface DiskResourceOptions {
  root: string
}

export interface DiskResourceState {
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

export class DiskResource extends BaseResource implements Resource {
  readonly kind = ResourceName.DISK
  readonly cachesReads: boolean = false
  override readonly indexTtl: number = 60
  readonly prompt = DISK_PROMPT
  readonly root: string
  readonly accessor: DiskAccessor
  readonly opsMap: Record<string, unknown> = {
    read_bytes: readCoreFn,
    write: writeCore,
    readdir: readdirCore,
    stat: statCore,
    unlink: unlinkCore,
    rmdir: rmdirCore,
    copy: copyCore,
    rename: renameCore,
    mkdir: mkdirCore,
    read_stream: streamCore,
    rm_recursive: rmRCore,
    du_total: duCore,
    du_all: duAllCore,
    create: createCore,
    truncate: truncateCore,
    exists: existsCore,
    find_flat: findCore,
    append: appendCore,
  }

  constructor(options: DiskResourceOptions) {
    super()
    this.root = path.resolve(options.root)
    this.accessor = new DiskAccessor(this.root)
  }

  async open(): Promise<void> {
    await mkdir(this.root, { recursive: true })
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  ops(): readonly RegisteredOp[] {
    return DISK_OPS
  }

  commands(): readonly RegisteredCommand[] {
    return DISK_COMMANDS
  }

  streamPath(p: PathSpec): AsyncIterable<Uint8Array> {
    return streamCore(this.accessor, p)
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return readCoreFn(this.accessor, p)
  }

  writeFile(p: PathSpec, data: Uint8Array): Promise<void> {
    return writeCore(this.accessor, p, data)
  }

  appendFile(p: PathSpec, data: Uint8Array): Promise<void> {
    return appendCore(this.accessor, p, data)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return readdirCore(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return statCore(this.accessor, p)
  }

  exists(p: PathSpec): Promise<boolean> {
    return existsCore(this.accessor, p)
  }

  mkdir(p: PathSpec, options?: { recursive?: boolean }): Promise<void> {
    return mkdirCore(this.accessor, p, options?.recursive === true)
  }

  rmdir(p: PathSpec): Promise<void> {
    return rmdirCore(this.accessor, p)
  }

  unlink(p: PathSpec): Promise<void> {
    return unlinkCore(this.accessor, p)
  }

  rename(src: PathSpec, dst: PathSpec): Promise<void> {
    return renameCore(this.accessor, src, dst)
  }

  truncate(p: PathSpec, length: number): Promise<void> {
    return truncateCore(this.accessor, p, length)
  }

  copy(src: PathSpec, dst: PathSpec): Promise<void> {
    return copyCore(this.accessor, src, dst)
  }

  rmR(p: PathSpec): Promise<void> {
    return rmRCore(this.accessor, p)
  }

  du(p: PathSpec): Promise<number> {
    return duCore(this.accessor, p)
  }

  find(p: PathSpec, options: FindOptions = {}): Promise<string[]> {
    return findCore(this.accessor, p, options as DiskFindOptions)
  }

  glob(paths: readonly PathSpec[], prefix = ''): Promise<PathSpec[]> {
    const effective = prefix
      ? paths.map((p) =>
          mountPrefixOf(p.virtual, p.resourcePath)
            ? p
            : new PathSpec({
                virtual: p.virtual,
                directory: p.directory,
                ...(p.pattern !== null ? { pattern: p.pattern } : {}),
                resolved: p.resolved,
                resourcePath: mountKey(p.virtual, prefix),
              }),
        )
      : paths
    return globCore(this.accessor, effective, this.index)
  }

  async getState(): Promise<DiskResourceState> {
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
      type: this.kind,
      files,
      modes,
    }
  }

  async loadState(state: DiskResourceState): Promise<void> {
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
