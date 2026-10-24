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

import { materialize, type ByteSource } from '../../io/types.ts'
import type { DatabricksVolumeAccessor } from '../../accessor/databricks_volume.ts'
import { copy as dbxCopy } from '../../core/databricks_volume/copy.ts'
import { create as dbxCreate } from '../../core/databricks_volume/create.ts'
import { exists as dbxExists } from '../../core/databricks_volume/exists.ts'
import { mkdir as dbxMkdir } from '../../core/databricks_volume/mkdir.ts'
import { read as dbxRead } from '../../core/databricks_volume/read.ts'
import { readdir as dbxReaddir } from '../../core/databricks_volume/readdir.ts'
import { rename as dbxRename } from '../../core/databricks_volume/rename.ts'
import { rmRecursive as dbxRmR } from '../../core/databricks_volume/rm.ts'
import { rmdir as dbxRmdir } from '../../core/databricks_volume/rmdir.ts'
import { stat as dbxStat } from '../../core/databricks_volume/stat.ts'
import { readStream as dbxStream } from '../../core/databricks_volume/stream.ts'
import { unlink as dbxUnlink } from '../../core/databricks_volume/unlink.ts'
import { write as dbxWrite } from '../../core/databricks_volume/write.ts'
import type { DirListing, FileStat, PathSpec } from '../../types.ts'
import type { Handed } from '../types.ts'
import { BaseVFS } from '../base.ts'
import { rstripSlash } from '../../utils/slash.ts'

/**
 * DatabricksVolume's functions over its accessor, which a host package builds
 * over its own transport.
 */
export class DatabricksVolumeVFSBase extends BaseVFS<DatabricksVolumeAccessor> {
  override readonly readsRanges: boolean = true

  override storageLocation(): string {
    const cfg = this.accessor.config
    const volume = `/Volumes/${cfg.catalog}/${cfg.schema}/${cfg.volume}`
    return `${this.name}:${cfg.host}:${volume}${rstripSlash(cfg.rootPath)}`
  }

  override readdir(path: PathSpec, handed?: Handed): Promise<FileStat[] | DirListing> {
    return dbxReaddir(this.accessor, path, handed?.limit)
  }

  override read(
    path: PathSpec,
    _handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<ByteSource> | AsyncIterable<Uint8Array> {
    if (offset === 0 && size === null) return dbxStream(this.accessor, path)
    return dbxRead(this.accessor, path, size === null ? { offset } : { offset, size })
  }

  override stat(path: PathSpec): Promise<FileStat> {
    return dbxStat(this.accessor, path)
  }

  override exists(path: PathSpec): Promise<boolean> {
    return dbxExists(this.accessor, path)
  }

  override async write(path: PathSpec, data: ByteSource): Promise<void> {
    return dbxWrite(this.accessor, path, await materialize(data))
  }

  override create(path: PathSpec): Promise<void> {
    return dbxCreate(this.accessor, path)
  }

  override mkdir(path: PathSpec, parents = false): Promise<void> {
    return dbxMkdir(this.accessor, path, parents)
  }

  override unlink(path: PathSpec): Promise<void> {
    return dbxUnlink(this.accessor, path)
  }

  override rmdir(path: PathSpec): Promise<void> {
    return dbxRmdir(this.accessor, path)
  }

  override async rmR(path: PathSpec): Promise<void> {
    await dbxRmR(this.accessor, path)
  }

  override rename(src: PathSpec, dst: PathSpec): Promise<void> {
    return dbxRename(this.accessor, src, dst)
  }

  override copy(src: PathSpec, dst: PathSpec): Promise<void> {
    return dbxCopy(this.accessor, src, dst)
  }
}
