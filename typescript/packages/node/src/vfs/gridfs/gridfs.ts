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

import { normalizeKeyPrefix } from '@struktoai/mirage-core/vfs/s3/config'
import { VFSName } from '@struktoai/mirage-core/types'

import { GridFSAccessor } from '../../accessor/gridfs.ts'

import { redactConfig, type GridFSConfig, type GridFSConfigRedacted } from './config.ts'
import { PROMPT } from './prompt.ts'
import { type DeltaHook } from '@struktoai/mirage-core/watch/index'
import { buildDeltaHook } from '../../core/gridfs/watch.ts'
import type { PathSpec, FileStat } from '@struktoai/mirage-core/types'
import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import type { FindOptions } from '@struktoai/mirage-core/vfs/types'
import type { DuEntries } from '@struktoai/mirage-core/vfs/types'
import { appendByRewrite } from '@struktoai/mirage-core/core/generic/rewrite'
import { readdir as gridfsReaddir } from '../../core/gridfs/readdir.ts'
import { read as gridfsRead } from '../../core/gridfs/read.ts'
import { stat as gridfsStat } from '../../core/gridfs/stat.ts'
import { readStream as gridfsStream } from '../../core/gridfs/stream.ts'
import { exists as gridfsExists } from '../../core/gridfs/exists.ts'
import { find as gridfsFind } from '../../core/gridfs/find.ts'
import { size as gridfsDu, entries as gridfsDuAll } from '../../core/gridfs/du/index.ts'
import { write as gridfsWrite } from '../../core/gridfs/write.ts'
import { create as gridfsCreate } from '../../core/gridfs/create.ts'
import { mkdir as gridfsMkdir } from '../../core/gridfs/mkdir.ts'
import { unlink as gridfsUnlink } from '../../core/gridfs/unlink.ts'
import { rmdir as gridfsRmdir } from '../../core/gridfs/rmdir.ts'
import { rmR as gridfsRmR } from '../../core/gridfs/rm.ts'
import { rename as gridfsRename } from '../../core/gridfs/rename.ts'
import { copy as gridfsCopy } from '../../core/gridfs/copy.ts'
import { truncate as gridfsTruncate } from '../../core/gridfs/truncate.ts'
import { SCOPE_ERROR } from '../../core/gridfs/constants.ts'

export interface GridFSVFSState {
  type: string
  config: GridFSConfigRedacted
}

export class GridFSVFS extends BaseVFS {
  override readonly name: string = VFSName.GRIDFS
  override readonly cachesReads: boolean = true
  override readonly supportsSnapshot: boolean = true
  // byte store: stat() sizes every file from metadata
  override readonly sizesAlwaysKnown: boolean = true
  // stat and read both stamp str(file_id), so the gate compares like
  // with like.
  override readonly readRevalidatable: boolean = true
  override readonly prompt: string = PROMPT
  readonly config: GridFSConfig
  override readonly accessor: GridFSAccessor

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

  override async close(): Promise<void> {
    await this.accessor.close()
    await super.close()
  }

  override readonly readsRanges: boolean = true

  override readonly maxGlobMatches: number = SCOPE_ERROR

  override readdir(path: PathSpec, index?: IndexCacheStore): Promise<string[]> {
    return gridfsReaddir(this.accessor, path, index)
  }

  override read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    if (offset === 0 && size === null) return gridfsRead(this.accessor, path, index)
    return gridfsRead(this.accessor, path, index, size === null ? { offset } : { offset, size })
  }

  override stat(path: PathSpec, index?: IndexCacheStore): Promise<FileStat> {
    return gridfsStat(this.accessor, path, index)
  }

  override readStream(path: PathSpec, _index?: IndexCacheStore): AsyncIterable<Uint8Array> {
    return gridfsStream(this.accessor, path)
  }

  override exists(path: PathSpec): Promise<boolean> {
    return gridfsExists(this.accessor, path)
  }

  override find(path: PathSpec, options: FindOptions, index?: IndexCacheStore): Promise<string[]> {
    return gridfsFind(this.accessor, path, options, index)
  }

  override duSize(path: PathSpec, index?: IndexCacheStore): Promise<number> {
    return gridfsDu(this.accessor, path, index)
  }

  override duEntries(path: PathSpec, index?: IndexCacheStore): Promise<DuEntries> {
    return gridfsDuAll(this.accessor, path, index)
  }

  override write(path: PathSpec, data: Uint8Array): Promise<void> {
    return gridfsWrite(this.accessor, path, data)
  }

  override append(path: PathSpec, data: Uint8Array, index?: IndexCacheStore): Promise<void> {
    return appendByRewrite(
      (p) => this.read(p, index),
      (p, d) => this.write(p, d),
      (p) => this.stat(p, index),
      path,
      data,
    )
  }

  override create(path: PathSpec): Promise<void> {
    return gridfsCreate(this.accessor, path)
  }

  override mkdir(path: PathSpec, parents = false): Promise<void> {
    return gridfsMkdir(this.accessor, path, parents)
  }

  override unlink(path: PathSpec): Promise<void> {
    return gridfsUnlink(this.accessor, path)
  }

  override rmdir(path: PathSpec, _index?: IndexCacheStore): Promise<void> {
    return gridfsRmdir(this.accessor, path)
  }

  override rmR(path: PathSpec): Promise<void> {
    return gridfsRmR(this.accessor, path)
  }

  override rename(src: PathSpec, dst: PathSpec): Promise<void> {
    return gridfsRename(this.accessor, src, dst)
  }

  override copy(src: PathSpec, dst: PathSpec): Promise<void> {
    return gridfsCopy(this.accessor, src, dst)
  }

  override truncate(path: PathSpec, length: number, noCreate = false): Promise<void> {
    return gridfsTruncate(this.accessor, path, length, noCreate)
  }

  override deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override getState(): Promise<GridFSVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactConfig(this.config),
    })
  }
}
