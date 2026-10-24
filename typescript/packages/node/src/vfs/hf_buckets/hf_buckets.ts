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
import { HfBucketsAccessor } from '../../accessor/hf_buckets.ts'
import {
  assertHfRepoId,
  HF_ENDPOINT,
  type HfBucketsConfig,
  type HfBucketsConfigRedacted,
  redactHfBucketsConfig,
} from './config.ts'
import { PROMPT } from './prompt.ts'
import type { PathSpec, FileStat } from '@struktoai/mirage-core/types'
import type { Handed } from '@struktoai/mirage-core/vfs/types'
import { readdir as hfReaddir } from '../../core/hf_buckets/readdir.ts'
import { read as hfRead } from '../../core/hf_buckets/read.ts'
import { stat as hfStat } from '../../core/hf_buckets/stat.ts'
import { readStream as hfStream } from '../../core/hf_buckets/stream.ts'
import { exists as hfExists } from '../../core/hf_buckets/exists.ts'
import { write as hfWrite } from '../../core/hf_buckets/write.ts'
import { create as hfCreate } from '../../core/hf_buckets/create.ts'
import { mkdir as hfMkdir } from '../../core/hf_buckets/mkdir.ts'
import { unlink as hfUnlink } from '../../core/hf_buckets/unlink.ts'
import { rmR as hfRmR } from '../../core/hf_buckets/rm.ts'
import { tree as hfTree } from '../../core/hf_buckets/readdir.ts'
import { rstripSlash, stripSlash } from '@struktoai/mirage-core/utils/slash'
import { FULL_SCAN_LIMIT } from '@struktoai/mirage-core/vfs/constants'

export interface HfBucketsVFSState {
  type: string
  config: HfBucketsConfigRedacted
}

export class HfBucketsVFS extends BaseVFS {
  override readonly name: string = VFSName.HF_BUCKETS
  override readonly prompt: string = PROMPT
  override readonly cachesReads: boolean = true
  // The Hub tree API reports each file's exact byte size (the LFS
  // object size for LFS files); readdir backfills any lister-omitted
  // size with one stat.
  override readonly sizesAlwaysKnown: boolean = true
  override readonly supportsSnapshot: boolean = true
  // stat stamps the paths-info xet hash and a read stamps its download's
  // strong ETag, which is that same hash, so a `fresh` probe compares like
  // with like.
  override readonly readRevalidatable: boolean = true
  readonly config: HfBucketsConfig
  override readonly accessor: HfBucketsAccessor

  override readonly fullScanLimit: number
  constructor(config: HfBucketsConfig) {
    super()
    this.fullScanLimit = config.fullScanLimit ?? FULL_SCAN_LIMIT
    assertHfRepoId(config.bucket, 'bucket')
    const normalized = normalizeKeyPrefix(config.keyPrefix)
    const cfg: HfBucketsConfig = { ...config }
    if (normalized !== undefined) {
      cfg.keyPrefix = normalized
    } else {
      delete cfg.keyPrefix
    }
    this.config = cfg
    this.accessor = new HfBucketsAccessor(this.config)
  }

  override readonly readsRanges: boolean = true

  override readTree(path: PathSpec): Promise<Map<string, FileStat> | null> {
    return hfTree(this.accessor, path)
  }

  override readdir(path: PathSpec): Promise<FileStat[]> {
    return hfReaddir(this.accessor, path)
  }

  override read(
    path: PathSpec,
    _handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<ByteSource> | AsyncIterable<Uint8Array> {
    if (offset === 0 && size === null) return hfStream(this.accessor, path)
    return hfRead(this.accessor, path, size === null ? { offset } : { offset, size })
  }

  override stat(path: PathSpec): Promise<FileStat> {
    return hfStat(this.accessor, path)
  }

  override exists(path: PathSpec): Promise<boolean> {
    return hfExists(this.accessor, path)
  }

  override write(path: PathSpec, data: ByteSource): Promise<FileStat | null> {
    return hfWrite(this.accessor, path, data)
  }

  override create(path: PathSpec): Promise<FileStat | null> {
    return hfCreate(this.accessor, path)
  }

  override mkdir(path: PathSpec, parents = false): Promise<void> {
    return hfMkdir(this.accessor, path, parents)
  }

  override unlink(path: PathSpec): Promise<void> {
    return hfUnlink(this.accessor, path)
  }

  override rmR(path: PathSpec): Promise<void> {
    return hfRmR(this.accessor, path)
  }

  override storageLocation(): string {
    // The endpoint, the bucket and the key prefix pin the objects two mounts
    // would share.
    const cfg = this.config
    const prefix = stripSlash(cfg.keyPrefix ?? '')
    const base = `${this.name}:${rstripSlash(cfg.endpoint ?? HF_ENDPOINT)}:${cfg.bucket}`
    return prefix === '' ? base : `${base}/${prefix}`
  }

  override getState(): Promise<HfBucketsVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactHfBucketsConfig(this.config),
    })
  }
}
