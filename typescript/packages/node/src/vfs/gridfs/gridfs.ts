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
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { normalizeKeyPrefix } from '@struktoai/mirage-core/vfs/s3/config'
import { VFSName } from '@struktoai/mirage-core/types'
import { GridFSAccessor } from '../../accessor/gridfs.ts'
import { redactConfig, type GridFSConfig, type GridFSConfigRedacted } from './config.ts'
import type { DirListing, PathSpec, FileStat } from '@struktoai/mirage-core/types'
import type { Handed } from '@struktoai/mirage-core/vfs/types'
import { appendByStreamedRewrite } from '@struktoai/mirage-core/core/generic/rewrite'
import { readdir as gridfsReaddir } from '../../core/gridfs/readdir.ts'
import { read as gridfsRead } from '../../core/gridfs/read.ts'
import { stat as gridfsStat } from '../../core/gridfs/stat.ts'
import { readStream as gridfsStream } from '../../core/gridfs/stream.ts'
import { exists as gridfsExists } from '../../core/gridfs/exists.ts'
import { write as gridfsWrite } from '../../core/gridfs/write.ts'
import { create as gridfsCreate } from '../../core/gridfs/create.ts'
import { mkdir as gridfsMkdir } from '../../core/gridfs/mkdir.ts'
import { unlink as gridfsUnlink } from '../../core/gridfs/unlink.ts'
import { rmdir as gridfsRmdir } from '../../core/gridfs/rmdir.ts'
import { rmR as gridfsRmR } from '../../core/gridfs/rm.ts'
import { rename as gridfsRename } from '../../core/gridfs/rename.ts'
import { copy as gridfsCopy } from '../../core/gridfs/copy.ts'
import { truncate as gridfsTruncate } from '../../core/gridfs/truncate.ts'
import { tree as gridfsTree } from '../../core/gridfs/readdir.ts'
import { stripSlash } from '@struktoai/mirage-core/utils/slash'

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

  override readTree(path: PathSpec, handed?: Handed): Promise<Map<string, FileStat> | null> {
    return gridfsTree(this.accessor, path, handed?.limit)
  }

  override readdir(path: PathSpec, handed?: Handed): Promise<FileStat[] | DirListing> {
    return gridfsReaddir(this.accessor, path, handed?.limit)
  }

  override read(
    path: PathSpec,
    _handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<ByteSource> | AsyncIterable<Uint8Array> {
    if (offset === 0 && size === null) return gridfsStream(this.accessor, path)
    return gridfsRead(this.accessor, path, size === null ? { offset } : { offset, size })
  }

  override stat(path: PathSpec): Promise<FileStat> {
    return gridfsStat(this.accessor, path)
  }

  override exists(path: PathSpec): Promise<boolean> {
    return gridfsExists(this.accessor, path)
  }

  override write(path: PathSpec, data: ByteSource, signal?: AbortSignal): Promise<FileStat | null> {
    return gridfsWrite(this.accessor, path, data, signal)
  }

  override append(path: PathSpec, data: ByteSource): Promise<FileStat | null | undefined> {
    return appendByStreamedRewrite(
      (p, remember) => gridfsStream(this.accessor, p, remember),
      (p, d) => this.write(p, d),
      (p) => this.stat(p),
      path,
      data,
    )
  }

  override create(path: PathSpec): Promise<FileStat | null> {
    return gridfsCreate(this.accessor, path)
  }

  override mkdir(path: PathSpec, parents = false): Promise<void> {
    return gridfsMkdir(this.accessor, path, parents)
  }

  override unlink(path: PathSpec): Promise<void> {
    return gridfsUnlink(this.accessor, path)
  }

  override rmdir(path: PathSpec): Promise<void> {
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

  override truncate(path: PathSpec, length: number, noCreate = false): Promise<FileStat | null> {
    return gridfsTruncate(this.accessor, path, length, noCreate)
  }

  override storageLocation(): string {
    // The hosts, the database, the bucket and the key prefix pin the files
    // two mounts would share. The URI's credentials are left out: they name
    // a login, not a store.
    const cfg = this.config
    const scheme = cfg.uri.indexOf('://')
    const rest = scheme === -1 ? cfg.uri : cfg.uri.slice(scheme + 3)
    const hosts = (rest.slice(rest.lastIndexOf('@') + 1).split('/')[0] ?? '').split('?')[0] ?? ''
    const prefix = stripSlash(cfg.keyPrefix ?? '')
    const base = `${this.name}:${hosts}/${cfg.database}/${cfg.bucket ?? 'fs'}`
    return prefix === '' ? base : `${base}/${prefix}`
  }

  override getState(): Promise<GridFSVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactConfig(this.config),
    })
  }
}
