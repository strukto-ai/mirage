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
import { appendByStreamedRewrite } from '../../core/generic/rewrite.ts'
import { checksum as s3Checksum } from '../../core/s3/checksum.ts'
import { MD5_ETAG_STORES } from '../../core/s3/constants.ts'
import { copy as s3Copy, copyFrom as s3CopyFrom } from '../../core/s3/copy.ts'
import { create as s3Create } from '../../core/s3/create.ts'
import { exists as s3Exists } from '../../core/s3/exists.ts'
import { mkdir as s3Mkdir } from '../../core/s3/mkdir.ts'
import { readdir as s3Readdir } from '../../core/s3/readdir.ts'
import { rename as s3Rename } from '../../core/s3/rename.ts'
import { rmR as s3RmR } from '../../core/s3/rm.ts'
import { rmdir as s3Rmdir } from '../../core/s3/rmdir.ts'
import { stat as s3Stat } from '../../core/s3/stat.ts'
import { readRange as s3ReadRange, readStream as s3Stream } from '../../core/s3/stream.ts'
import { truncate as s3Truncate } from '../../core/s3/truncate.ts'
import { unlink as s3Unlink } from '../../core/s3/unlink.ts'
import type { ByteSource } from '../../io/types.ts'
import { write as s3Write } from '../../core/s3/write.ts'
import type { DirListing, FileStat, PathSpec } from '../../types.ts'
import { BaseVFS } from '../base.ts'
import type { Handed } from '../types.ts'
import { exdev } from '../../errors/fs.ts'
import { tree as s3Tree } from '../../core/s3/readdir.ts'

/**
 * S3's functions over its accessor, which the node and browser
 * packages build over their own transport.
 */
export class S3VFSBase extends BaseVFS<S3Accessor> {
  override readonly readsRanges: boolean = true

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

  override readTree(path: PathSpec, handed?: Handed): Promise<Map<string, FileStat> | null> {
    return s3Tree(this.accessor, path, handed?.limit)
  }

  override readdir(path: PathSpec, handed?: Handed): Promise<FileStat[] | DirListing> {
    return s3Readdir(this.accessor, path, handed?.limit)
  }

  override read(
    path: PathSpec,
    _handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<ByteSource> | AsyncIterable<Uint8Array> {
    if (offset === 0 && size === null) return s3Stream(this.accessor, path)
    return s3ReadRange(this.accessor, path, offset, size)
  }

  override stat(path: PathSpec): Promise<FileStat> {
    return s3Stat(this.accessor, path)
  }

  override copyFrom(source: BaseVFS, src: PathSpec, dst: PathSpec): Promise<void> {
    if (!(source instanceof S3VFSBase)) return Promise.reject(exdev(dst))
    return s3CopyFrom(this.accessor, source.accessor, src, dst)
  }

  override checksum(path: PathSpec, algorithm: string): Promise<string | null> {
    if (!MD5_ETAG_STORES.has(this.name) || this.presigned) return Promise.resolve(null)
    const aws = this.name === 's3' && this.resolvedEndpoint === undefined
    return s3Checksum(this.accessor, path, algorithm, aws)
  }

  override exists(path: PathSpec): Promise<boolean> {
    return s3Exists(this.accessor, path)
  }

  override write(path: PathSpec, data: ByteSource, signal?: AbortSignal): Promise<FileStat | null> {
    return s3Write(this.accessor, path, data, signal)
  }

  override append(path: PathSpec, data: ByteSource): Promise<FileStat | null | undefined> {
    return appendByStreamedRewrite(
      (p, remember) => s3Stream(this.accessor, p, remember),
      (p, d) => this.write(p, d),
      (p) => this.stat(p),
      path,
      data,
    )
  }

  override create(path: PathSpec): Promise<FileStat | null> {
    return s3Create(this.accessor, path)
  }

  override mkdir(path: PathSpec, parents = false): Promise<void> {
    return s3Mkdir(this.accessor, path, parents)
  }

  override unlink(path: PathSpec): Promise<void> {
    return s3Unlink(this.accessor, path)
  }

  override rmdir(path: PathSpec): Promise<void> {
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

  override truncate(path: PathSpec, length: number, noCreate = false): Promise<FileStat | null> {
    return s3Truncate(this.accessor, path, length, noCreate)
  }
}
