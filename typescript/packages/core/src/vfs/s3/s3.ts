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

import type { S3Accessor } from '../../accessor/s3.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { appendByRewrite } from '../../core/generic/rewrite.ts'
import { SCOPE_ERROR } from '../../core/s3/constants.ts'
import { copy as s3Copy } from '../../core/s3/copy.ts'
import { create as s3Create } from '../../core/s3/create.ts'
import { size as s3Du, entries as s3DuAll } from '../../core/s3/du/index.ts'
import { exists as s3Exists } from '../../core/s3/exists.ts'
import { find as s3Find } from '../../core/s3/find.ts'
import { mkdir as s3Mkdir } from '../../core/s3/mkdir.ts'
import { read as s3Read } from '../../core/s3/read.ts'
import { readdir as s3Readdir } from '../../core/s3/readdir.ts'
import { rename as s3Rename } from '../../core/s3/rename.ts'
import { rmR as s3RmR } from '../../core/s3/rm.ts'
import { rmdir as s3Rmdir } from '../../core/s3/rmdir.ts'
import { stat as s3Stat } from '../../core/s3/stat.ts'
import { readRange as s3ReadRange, readStream as s3Stream } from '../../core/s3/stream.ts'
import { truncate as s3Truncate } from '../../core/s3/truncate.ts'
import { unlink as s3Unlink } from '../../core/s3/unlink.ts'
import { write as s3Write } from '../../core/s3/write.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import { BaseVFS, type FindOptions } from '../base.ts'
import type { DuEntries } from '../types.ts'

/**
 * S3's functions over its accessor, which the node and browser
 * packages build over their own transport.
 */
export class S3VFSBase extends BaseVFS<S3Accessor> {
  override readonly readsRanges: boolean = true
  override readonly maxGlobMatches: number = SCOPE_ERROR

  /**
   * The endpoint this mount's writes go to, for its write-condition row: the
   * config's. The node mount also reads the environment. Mirrors Python's
   * `resolved_endpoint`.
   */
  get resolvedEndpoint(): string | undefined {
    return this.accessor.config.endpoint
  }

  /** Whether requests go through presigned URLs, which carry no condition. */
  get presigned(): boolean {
    return this.accessor.config.presignedUrlProvider !== undefined
  }

  override readdir(path: PathSpec, index?: IndexCacheStore): Promise<string[]> {
    return s3Readdir(this.accessor, path, index)
  }

  override read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    if (offset === 0 && size === null) return s3Read(this.accessor, path, index)
    return s3ReadRange(this.accessor, path, index, offset, size)
  }

  override stat(path: PathSpec, index?: IndexCacheStore): Promise<FileStat> {
    return s3Stat(this.accessor, path, index)
  }

  override readStream(path: PathSpec, _index?: IndexCacheStore): AsyncIterable<Uint8Array> {
    return s3Stream(this.accessor, path)
  }

  override exists(path: PathSpec): Promise<boolean> {
    return s3Exists(this.accessor, path)
  }

  override find(path: PathSpec, options: FindOptions, index?: IndexCacheStore): Promise<string[]> {
    return s3Find(this.accessor, path, options, index)
  }

  override duSize(path: PathSpec, index?: IndexCacheStore): Promise<number> {
    return s3Du(this.accessor, path, index)
  }

  override duEntries(path: PathSpec, index?: IndexCacheStore): Promise<DuEntries> {
    return s3DuAll(this.accessor, path, index)
  }

  override write(path: PathSpec, data: Uint8Array): Promise<void> {
    return s3Write(this.accessor, path, data)
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
    return s3Create(this.accessor, path)
  }

  override mkdir(path: PathSpec, parents = false): Promise<void> {
    return s3Mkdir(this.accessor, path, parents)
  }

  override unlink(path: PathSpec): Promise<void> {
    return s3Unlink(this.accessor, path)
  }

  override rmdir(path: PathSpec, _index?: IndexCacheStore): Promise<void> {
    return s3Rmdir(this.accessor, path)
  }

  override rmR(path: PathSpec): Promise<void> {
    return s3RmR(this.accessor, path)
  }

  override rename(src: PathSpec, dst: PathSpec): Promise<void> {
    return s3Rename(this.accessor, src, dst)
  }

  override copy(src: PathSpec, dst: PathSpec): Promise<void> {
    return s3Copy(this.accessor, src, dst)
  }

  override truncate(path: PathSpec, length: number, noCreate = false): Promise<void> {
    return s3Truncate(this.accessor, path, length, noCreate)
  }
}
