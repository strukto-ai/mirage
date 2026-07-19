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
  BaseResource,
  PathSpec,
  ResourceName,
  makeResolveGlob,
  mountKey,
  mountPrefixOf,
  normalizeKeyPrefix,
  type FileStat,
  type FindOptions,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
} from '@struktoai/mirage-core'
import { GridFSAccessor } from '../../accessor/gridfs.ts'
import { GRIDFS_COMMANDS } from '../../commands/builtin/gridfs/index.ts'
import { SCOPE_ERROR } from '../../core/gridfs/constants.ts'
import { copy as copyCore } from '../../core/gridfs/copy.ts'
import { create as createCore } from '../../core/gridfs/create.ts'
import { du as duCore, duAll as duAllCore } from '../../core/gridfs/du.ts'
import { exists as existsCore } from '../../core/gridfs/exists.ts'
import { find as findCore } from '../../core/gridfs/find.ts'
import { mkdir as mkdirCore } from '../../core/gridfs/mkdir.ts'
import { read as readCore } from '../../core/gridfs/read.ts'
import { readdir as readdirCore } from '../../core/gridfs/readdir.ts'
import { rename as renameCore } from '../../core/gridfs/rename.ts'
import { rmR as rmRCore } from '../../core/gridfs/rm.ts'
import { rmdir as rmdirCore } from '../../core/gridfs/rmdir.ts'
import { stat as statCore } from '../../core/gridfs/stat.ts'
import { rangeRead as rangeReadCore, stream as streamCore } from '../../core/gridfs/stream.ts'
import { truncate as truncateCore } from '../../core/gridfs/truncate.ts'
import { unlink as unlinkCore } from '../../core/gridfs/unlink.ts'
import { write as writeCore } from '../../core/gridfs/write.ts'
import { GRIDFS_OPS } from '../../ops/gridfs/index.ts'
import { redactConfig, type GridFSConfig, type GridFSConfigRedacted } from './config.ts'
import { GRIDFS_PROMPT } from './prompt.ts'

const globCore = makeResolveGlob(readdirCore, SCOPE_ERROR)

export interface GridFSResourceState {
  type: string
  config: GridFSConfigRedacted
}

export class GridFSResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.GRIDFS
  readonly cachesReads: boolean = true
  readonly supportsSnapshot: boolean = true
  override readonly indexTtl: number = 600
  readonly prompt: string = GRIDFS_PROMPT
  readonly config: GridFSConfig
  readonly accessor: GridFSAccessor
  readonly opsMap: Record<string, unknown> = {
    read_bytes: readCore,
    write: writeCore,
    readdir: readdirCore,
    stat: statCore,
    unlink: unlinkCore,
    rmdir: rmdirCore,
    copy: copyCore,
    rename: renameCore,
    mkdir: mkdirCore,
    read_stream: streamCore,
    range_read: rangeReadCore,
    rm_recursive: rmRCore,
    du_total: duCore,
    du_all: duAllCore,
    create: createCore,
    truncate: truncateCore,
    exists: existsCore,
    find_flat: findCore,
  }

  constructor(config: GridFSConfig) {
    super()
    const normalized = normalizeKeyPrefix(config.keyPrefix)
    const cfg: GridFSConfig = { ...config }
    if (normalized !== undefined) {
      cfg.keyPrefix = normalized
    } else {
      delete cfg.keyPrefix
    }
    this.config = cfg
    this.accessor = new GridFSAccessor(this.config)
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  async close(): Promise<void> {
    await this.accessor.close()
  }

  commands(): readonly RegisteredCommand[] {
    return GRIDFS_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return GRIDFS_OPS
  }

  streamPath(p: PathSpec): AsyncIterable<Uint8Array> {
    return streamCore(this.accessor, p)
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return readCore(this.accessor, p)
  }

  writeFile(p: PathSpec, data: Uint8Array): Promise<void> {
    return writeCore(this.accessor, p, data)
  }

  async appendFile(p: PathSpec, data: Uint8Array): Promise<void> {
    let existing: Uint8Array
    try {
      existing = await readCore(this.accessor, p)
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'ENOENT') {
        existing = new Uint8Array()
      } else {
        throw err
      }
    }
    const merged = new Uint8Array(existing.byteLength + data.byteLength)
    merged.set(existing, 0)
    merged.set(data, existing.byteLength)
    await writeCore(this.accessor, p, merged)
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

  mkdir(p: PathSpec): Promise<void> {
    return mkdirCore(this.accessor, p)
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
    return findCore(this.accessor, p, options)
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

  getState(): Promise<GridFSResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactConfig(this.config),
    })
  }

  loadState(_state: GridFSResourceState): Promise<void> {
    return Promise.resolve()
  }
}
