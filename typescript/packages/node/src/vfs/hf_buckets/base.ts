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

import { makeResolveGlob } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import type { FindOptions, VFSStateBase } from '@struktoai/mirage-core/vfs/base'
import { PathSpec } from '@struktoai/mirage-core/types'
import type { FileStat } from '@struktoai/mirage-core/types'
import { mountKey, mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import type { HfAccessor } from '../../accessor/hf.ts'
import { HF_COMMANDS } from '../../commands/builtin/hf/index.ts'
import { SCOPE_ERROR } from '../../core/hf/constants.ts'
import { size as duSizeCore } from '../../core/hf/du/index.ts'
import { exists as existsCore } from '../../core/hf/exists.ts'
import { find as findCore } from '../../core/hf/find.ts'
import { mkdir as mkdirCore } from '../../core/hf/mkdir.ts'
import { read as readCore } from '../../core/hf/read.ts'
import { readdir as readdirCore } from '../../core/hf/readdir.ts'
import { stat as statCore } from '../../core/hf/stat.ts'
import { stream as streamCore } from '../../core/hf/stream.ts'
import { unlink as unlinkCore } from '../../core/hf/unlink.ts'
import { write as writeCore } from '../../core/hf/write.ts'
import { HF_OPS } from '../../ops/hf/index.ts'
import { type DeltaHook } from '@struktoai/mirage-core/watch/index'
import { buildDeltaHook } from '../../core/hf/watch.ts'

const globCore = makeResolveGlob(readdirCore, SCOPE_ERROR)

export abstract class HfVFS extends BaseVFS {
  abstract override readonly prompt: string
  abstract override readonly accessor: HfAccessor
  // Narrowed back to abstract, so BaseVFS's bare `{type}` cannot reach
  // a Hub VFS: all four carry a config and so owe their own redaction,
  // and inheriting the default would drop it and read back as an empty
  // mount. Python has no shared Hub base — its four VFS each spell
  // `get_state` — so this only pins the habit down.
  abstract override getState(): Promise<VFSStateBase>
  override readonly cachesReads: boolean = true
  // The Hub tree API reports each file's exact byte size (the LFS
  // object size for LFS files); readdir backfills any lister-omitted
  // size with one stat.
  override readonly sizesAlwaysKnown: boolean = true
  override readonly supportsSnapshot: boolean = true
  override commands(): readonly RegisteredCommand[] {
    return HF_COMMANDS
  }

  override ops(): readonly RegisteredOp[] {
    return HF_OPS
  }

  override streamPath(p: PathSpec): AsyncIterable<Uint8Array> {
    return streamCore(this.accessor, p)
  }

  override readFile(p: PathSpec): Promise<Uint8Array> {
    return readCore(this.accessor, p, this.index)
  }

  override writeFile(p: PathSpec, data: Uint8Array): Promise<void> {
    return writeCore(this.accessor, p, data)
  }

  override readdir(p: PathSpec): Promise<string[]> {
    return readdirCore(this.accessor, p, this.index)
  }

  override stat(p: PathSpec): Promise<FileStat> {
    return statCore(this.accessor, p, this.index)
  }

  override exists(p: PathSpec): Promise<boolean> {
    return existsCore(this.accessor, p)
  }

  override mkdir(p: PathSpec): Promise<void> {
    return mkdirCore(this.accessor, p)
  }

  override unlink(p: PathSpec): Promise<void> {
    return unlinkCore(this.accessor, p)
  }

  override du(p: PathSpec): Promise<number> {
    return duSizeCore(this.accessor, p)
  }

  override find(p: PathSpec, options: FindOptions = {}): Promise<string[]> {
    return findCore(this.accessor, p, options)
  }

  override deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override glob(paths: readonly PathSpec[], prefix = ''): Promise<PathSpec[]> {
    const effective = prefix
      ? paths.map((p) =>
          mountPrefixOf(p.virtual, p.vfsPath)
            ? p
            : new PathSpec({
                virtual: p.virtual,
                directory: p.directory,
                ...(p.pattern !== null ? { pattern: p.pattern } : {}),
                resolved: p.resolved,
                vfsPath: mountKey(p.virtual, prefix),
              }),
        )
      : paths
    return globCore(this.accessor, effective, this.index)
  }

  override loadState(_state: unknown): Promise<void> {
    return Promise.resolve()
  }
}
