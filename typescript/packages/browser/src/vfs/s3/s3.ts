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

import { S3VFSBase } from '@struktoai/mirage-core/vfs/s3/s3'
import { S3Accessor } from '@struktoai/mirage-core/accessor/s3'

import { buildDeltaHook } from '@struktoai/mirage-core/core/s3/watch'

import { normalizeKeyPrefix } from '@struktoai/mirage-core/vfs/s3/config'
import { s3StorageLocation } from '@struktoai/mirage-core/vfs/s3/storage_id'
import { VFSName } from '@struktoai/mirage-core/types'

import { type DeltaHook } from '@struktoai/mirage-core/watch/index'
import { redactConfig, type S3Config, type S3ConfigRedacted } from './config.ts'
import { PROMPT } from './prompt.ts'

export interface S3VFSState {
  type: string
  config: S3ConfigRedacted
}

export class S3VFS extends S3VFSBase {
  override readonly supportsSnapshot: boolean = true
  override readonly name: string = VFSName.S3
  override readonly cachesReads: boolean = true
  // A HEAD carries ContentLength, so a size is always knowable without
  // fetching. Every sibling browser VFS says so; s3 was the one that
  // did not, and its node twin has always declared it.
  override readonly sizesAlwaysKnown: boolean = true
  // stat and read both stamp the ETag, so the gate compares like with
  // like. Inherited by every S3AliasVFS provider.
  override readonly readRevalidatable: boolean = true
  override readonly prompt: string = PROMPT
  readonly config: S3Config
  override readonly accessor: S3Accessor

  constructor(config: S3Config) {
    super()
    // Normalized as node's S3VFS does: the keys are `prefix + path`, so a
    // raw `team/x` keyed `team/xa.txt` and a raw `/team/x/` a leading slash.
    const normalized = normalizeKeyPrefix(config.keyPrefix)
    const cfg: S3Config = { ...config }
    if (normalized !== undefined) {
      cfg.keyPrefix = normalized
    } else {
      delete cfg.keyPrefix
    }
    this.config = cfg
    this.accessor = new S3Accessor(this.config)
  }

  // Without this, two mounts of one bucket at different prefixes are two
  // storages, so `mv` between them copies an object over itself and then
  // unlinks the source. Node has always declared it; the shared helper keeps
  // the two runtimes from computing different identities for one bucket.
  override storageLocation(): string {
    return s3StorageLocation(this.config)
  }

  override deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override getState(): Promise<S3VFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactConfig(this.config),
    })
  }
}
