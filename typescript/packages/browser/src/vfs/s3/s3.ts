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
import { S3_COMMANDS } from '@struktoai/mirage-core/commands/builtin/s3/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { create as createCore } from '@struktoai/mirage-core/core/s3/create'
import { rangeRead as rangeReadCore } from '@struktoai/mirage-core/core/s3/stream'
import { buildDeltaHook } from '@struktoai/mirage-core/core/s3/watch'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { S3_OPS } from '@struktoai/mirage-core/ops/s3/index'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { s3StorageLocation } from '@struktoai/mirage-core/vfs/s3/storage_id'
import { VFSName } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { type DeltaHook } from '@struktoai/mirage-core/watch/index'
import { redactConfig, type S3Config, type S3ConfigRedacted } from './config.ts'
export const S3_BROWSER_PROMPT = `{prefix}
  Remote S3 bucket accessed via presigned URLs (browser runtime).
  Supports the full filesystem command set: ls/tree/cat/grep/find/du/cp/mv/rm/etc.
  Listing operations require the presigner to sign LIST/COPY operations in
  addition to GET/PUT/HEAD/DELETE — see S3BrowserPresignedUrlProvider docs.`

export interface S3VFSState {
  type: string
  config: S3ConfigRedacted
}

export class S3VFS extends BaseVFS {
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
  override readonly indexTtl: number = 600
  override readonly prompt: string = S3_BROWSER_PROMPT
  readonly config: S3Config
  override readonly accessor: S3Accessor

  constructor(config: S3Config) {
    super()
    this.config = config
    this.accessor = new S3Accessor(this.config)
  }

  // Without this, two mounts of one bucket at different prefixes are two
  // storages, so `mv` between them copies an object over itself and then
  // unlinks the source. Node has always declared it; the shared helper keeps
  // the two runtimes from computing different identities for one bucket.
  override storageLocation(): string {
    return s3StorageLocation(this.name, this.config)
  }
  override commands(): readonly RegisteredCommand[] {
    return S3_COMMANDS.toArray()
  }

  override ops(): readonly RegisteredOp[] {
    return S3_OPS
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

  override loadState(_state: S3VFSState): Promise<void> {
    return Promise.resolve()
  }

  _rangeRead(p: PathSpec, offset: number, size: number): Promise<Uint8Array> {
    return rangeReadCore(this.accessor, p, offset, size)
  }

  _create(p: PathSpec): Promise<void> {
    return createCore(this.accessor, p)
  }
}
