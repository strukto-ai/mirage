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

import type { ByteSource } from '../../io/types.ts'
import type { TiDBFilesystemAccessor } from '../../accessor/tidb_filesystem.ts'
import { append as tfsAppend } from '../../core/tidb_filesystem/append.ts'
import { create as tfsCreate } from '../../core/tidb_filesystem/create.ts'
import { exists as tfsExists } from '../../core/tidb_filesystem/exists.ts'
import { mkdir as tfsMkdir } from '../../core/tidb_filesystem/mkdir.ts'
import { read as tfsRead } from '../../core/tidb_filesystem/read.ts'
import { readdir as tfsReaddir } from '../../core/tidb_filesystem/readdir.ts'
import { rename as tfsRename } from '../../core/tidb_filesystem/rename.ts'
import { rmRecursive as tfsRmR } from '../../core/tidb_filesystem/rm.ts'
import { rmdir as tfsRmdir } from '../../core/tidb_filesystem/rmdir.ts'
import { stat as tfsStat } from '../../core/tidb_filesystem/stat.ts'
import { readStream as tfsStream } from '../../core/tidb_filesystem/stream.ts'
import { unlink as tfsUnlink } from '../../core/tidb_filesystem/unlink.ts'
import { write as tfsWrite } from '../../core/tidb_filesystem/write.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import { BaseVFS } from '../base.ts'
import type { Handed } from '../types.ts'

/**
 * TiDBFilesystem's functions over its accessor, which a host package builds
 * over its own transport.
 */
export class TiDBFilesystemVFSBase extends BaseVFS<TiDBFilesystemAccessor> {
  override readonly readsRanges: boolean = true

  override readdir(path: PathSpec): Promise<FileStat[]> {
    return tfsReaddir(this.accessor, path)
  }

  override read(
    path: PathSpec,
    _handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<ByteSource> | AsyncIterable<Uint8Array> {
    if (offset === 0 && size === null) return tfsStream(this.accessor, path)
    return tfsRead(this.accessor, path, offset, size)
  }

  override stat(path: PathSpec): Promise<FileStat> {
    return tfsStat(this.accessor, path)
  }

  override exists(path: PathSpec): Promise<boolean> {
    return tfsExists(this.accessor, path)
  }

  override write(path: PathSpec, data: ByteSource): Promise<void> {
    return tfsWrite(this.accessor, path, data)
  }

  override append(path: PathSpec, data: ByteSource): Promise<void> {
    return tfsAppend(this.accessor, path, data)
  }

  override create(path: PathSpec): Promise<void> {
    return tfsCreate(this.accessor, path)
  }

  override mkdir(path: PathSpec, parents = false): Promise<void> {
    return tfsMkdir(this.accessor, path, parents)
  }

  override unlink(path: PathSpec): Promise<void> {
    return tfsUnlink(this.accessor, path)
  }

  override rmdir(path: PathSpec): Promise<void> {
    return tfsRmdir(this.accessor, path)
  }

  override rmR(path: PathSpec): Promise<void> {
    return tfsRmR(this.accessor, path)
  }

  override rename(src: PathSpec, dst: PathSpec): Promise<void> {
    return tfsRename(this.accessor, src, dst)
  }
}
