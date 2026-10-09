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
import { type DeltaHook } from '@struktoai/mirage-core/watch/index'
import { HfBucketsAccessor } from '../../accessor/hf_buckets.ts'
import { buildDeltaHook } from '../../core/hf_buckets/watch.ts'
import {
  assertHfRepoId,
  type HfBucketsConfig,
  type HfBucketsConfigRedacted,
  redactHfBucketsConfig,
} from './config.ts'
import { PROMPT } from './prompt.ts'
import type { PathSpec, FileStat } from '@struktoai/mirage-core/types'
import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import type { FindOptions } from '@struktoai/mirage-core/vfs/types'
import type { DuEntries } from '@struktoai/mirage-core/vfs/types'
import { readdir as hfReaddir } from '../../core/hf_buckets/readdir.ts'
import { read as hfRead } from '../../core/hf_buckets/read.ts'
import { stat as hfStat } from '../../core/hf_buckets/stat.ts'
import { readStream as hfStream } from '../../core/hf_buckets/stream.ts'
import { exists as hfExists } from '../../core/hf_buckets/exists.ts'
import { find as hfFind } from '../../core/hf_buckets/find.ts'
import { size as hfDu, entries as hfDuAll } from '../../core/hf_buckets/du/index.ts'
import { write as hfWrite } from '../../core/hf_buckets/write.ts'
import { create as hfCreate } from '../../core/hf_buckets/create.ts'
import { mkdir as hfMkdir } from '../../core/hf_buckets/mkdir.ts'
import { unlink as hfUnlink } from '../../core/hf_buckets/unlink.ts'
import { rmR as hfRmR } from '../../core/hf_buckets/rm.ts'
import { SCOPE_ERROR } from '../../core/hf_buckets/constants.ts'

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

  constructor(config: HfBucketsConfig) {
    super()
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

  override readonly maxGlobMatches: number = SCOPE_ERROR

  override readdir(path: PathSpec, index?: IndexCacheStore): Promise<string[]> {
    return hfReaddir(this.accessor, path, index)
  }

  override read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    if (offset === 0 && size === null) return hfRead(this.accessor, path, index)
    return hfRead(this.accessor, path, index, size === null ? { offset } : { offset, size })
  }

  override stat(path: PathSpec, index?: IndexCacheStore): Promise<FileStat> {
    return hfStat(this.accessor, path, index)
  }

  override readStream(path: PathSpec, index?: IndexCacheStore): AsyncIterable<Uint8Array> {
    return hfStream(this.accessor, path, index)
  }

  override exists(path: PathSpec): Promise<boolean> {
    return hfExists(this.accessor, path)
  }

  override find(path: PathSpec, options: FindOptions, index?: IndexCacheStore): Promise<string[]> {
    return hfFind(this.accessor, path, options, index)
  }

  override duSize(path: PathSpec, index?: IndexCacheStore): Promise<number> {
    return hfDu(this.accessor, path, index)
  }

  override duEntries(path: PathSpec, index?: IndexCacheStore): Promise<DuEntries> {
    return hfDuAll(this.accessor, path, index)
  }

  override write(path: PathSpec, data: Uint8Array): Promise<void> {
    return hfWrite(this.accessor, path, data)
  }

  override create(path: PathSpec): Promise<void> {
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

  override deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override getState(): Promise<HfBucketsVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactHfBucketsConfig(this.config),
    })
  }
}
