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

import { BoundVFS } from '@struktoai/mirage-core/vfs/bound'
import { HF_IO } from '../../commands/builtin/hf/io.ts'

import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'

import type { FindOptions, VFS, VFSStateBase } from '@struktoai/mirage-core/vfs/base'
import type { PathSpec } from '@struktoai/mirage-core/types'

import type { HfBucketsAccessor } from '../../accessor/hf.ts'
import { HF_COMMANDS } from '../../commands/builtin/hf/index.ts'

import { HF_OPS } from '../../ops/hf/index.ts'
import { type DeltaHook } from '@struktoai/mirage-core/watch/index'
import { buildDeltaHook } from '../../core/hf/watch.ts'

export abstract class HfVFS extends BoundVFS<HfBucketsAccessor> implements VFS {
  declare writeFile: (p: PathSpec, data: Uint8Array) => Promise<void>

  declare exists: (p: PathSpec) => Promise<boolean>

  declare mkdir: (p: PathSpec) => Promise<void>

  declare unlink: (p: PathSpec) => Promise<void>

  declare du: (p: PathSpec) => Promise<number>

  declare find: (p: PathSpec, options?: FindOptions) => Promise<string[]>

  constructor() {
    super(HF_IO)
  }

  abstract readonly prompt: string
  abstract override readonly accessor: HfBucketsAccessor
  // Narrowed back to abstract, so BaseVFS's bare `{type}` cannot reach
  // a Hub VFS: all four carry a config and so owe their own redaction,
  // and inheriting the default would drop it and read back as an empty
  // mount. Python has no shared Hub base — its four VFS each spell
  // `get_state` — so this only pins the habit down.
  abstract override getState(): Promise<VFSStateBase>
  readonly cachesReads: boolean = true
  // The Hub tree API reports each file's exact byte size (the LFS
  // object size for LFS files); readdir backfills any lister-omitted
  // size with one stat.
  readonly sizesAlwaysKnown: boolean = true
  readonly supportsSnapshot: boolean = true
  // stat stamps the paths-info xet hash and a read stamps its download's
  // strong ETag, which is that same hash, so a `fresh` probe compares like
  // with like.
  readonly readRevalidatable: boolean = true

  commands(): readonly RegisteredCommand[] {
    return HF_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return HF_OPS
  }

  deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }
}
