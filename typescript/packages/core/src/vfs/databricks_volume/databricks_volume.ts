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

import type { DatabricksVolumeAccessor } from '../../accessor/databricks_volume.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
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
import { appendByRewrite } from '../../core/generic/rewrite.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import { BaseVFS } from '../base.ts'

/**
 * DatabricksVolume's functions over its accessor, which a host package builds
 * over its own transport.
 */
export class DatabricksVolumeVFSBase extends BaseVFS<DatabricksVolumeAccessor> {
  override readonly readsRanges: boolean = true

  override readdir(path: PathSpec, index?: IndexCacheStore): Promise<string[]> {
    return dbxReaddir(this.accessor, path, index)
  }

  override read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    if (offset === 0 && size === null) return dbxRead(this.accessor, path, index)
    return dbxRead(this.accessor, path, index, size === null ? { offset } : { offset, size })
  }

  override stat(path: PathSpec, index?: IndexCacheStore): Promise<FileStat> {
    return dbxStat(this.accessor, path, index)
  }

  override readStream(path: PathSpec, _index?: IndexCacheStore): AsyncIterable<Uint8Array> {
    return dbxStream(this.accessor, path)
  }

  override exists(path: PathSpec): Promise<boolean> {
    return dbxExists(this.accessor, path)
  }

  override write(path: PathSpec, data: Uint8Array): Promise<void> {
    return dbxWrite(this.accessor, path, data)
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
    return dbxCreate(this.accessor, path)
  }

  override mkdir(path: PathSpec, parents = false): Promise<void> {
    return dbxMkdir(this.accessor, path, undefined, parents)
  }

  override unlink(path: PathSpec): Promise<void> {
    return dbxUnlink(this.accessor, path)
  }

  override rmdir(path: PathSpec, index?: IndexCacheStore): Promise<void> {
    return dbxRmdir(this.accessor, path, index)
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
