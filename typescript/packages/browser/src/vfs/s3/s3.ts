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

import { S3Accessor } from '@struktoai/mirage-core/accessor/s3'
import { VFSName } from '@struktoai/mirage-core/types'
import { normalizeKeyPrefix } from '@struktoai/mirage-core/vfs/s3/config'
import { S3VFS as CoreS3VFS } from '@struktoai/mirage-core/vfs/s3/s3'
import { s3StorageLocation } from '@struktoai/mirage-core/vfs/s3/storage_id'
import type { RedactedSchema } from '@struktoai/mirage-core/vfs/secrets'
import type { ConfigState } from '@struktoai/mirage-core/vfs/types'
import { S3Config } from './config.ts'

export class S3VFS extends CoreS3VFS {
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

  override getState(): Promise<ConfigState<RedactedSchema<typeof S3Config>>> {
    return Promise.resolve(this.configState(S3Config, this.config))
  }
}
