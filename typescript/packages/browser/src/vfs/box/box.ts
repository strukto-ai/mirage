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

import { BoxAccessor } from '@struktoai/mirage-core/accessor/box'
import { BOX_COMMANDS } from '@struktoai/mirage-core/commands/builtin/box/index'
import { makeResolveGlob } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { BoxTokenManager } from '@struktoai/mirage-core/core/box/client'
import { read as boxRead } from '@struktoai/mirage-core/core/box/read'
import { readdir as boxReaddir } from '@struktoai/mirage-core/core/box/readdir'
import { stat as boxStat } from '@struktoai/mirage-core/core/box/stat'
import { buildDeltaHook } from '@struktoai/mirage-core/core/box/watch'
import { BOX_OPS } from '@struktoai/mirage-core/ops/box/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import type { VFS } from '@struktoai/mirage-core/vfs/base'
import { BOX_PROMPT } from '@struktoai/mirage-core/vfs/box/prompt'
import { PathSpec, VFSName } from '@struktoai/mirage-core/types'
import type { FileStat } from '@struktoai/mirage-core/types'
import { mountKey, mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import { type DeltaHook } from '@struktoai/mirage-core/watch/index'
import { redactBoxConfig, type BoxConfig, type BoxConfigRedacted } from './config.ts'

const boxResolveGlob = makeResolveGlob(boxReaddir)

export interface BoxVFSState {
  type: string
  config: BoxConfigRedacted
}

export class BoxVFS extends BaseVFS implements VFS {
  readonly kind: string = VFSName.BOX
  readonly cachesReads: boolean = true
  // Box item listings carry an exact byte `size` for every file (0
  // included); sizeless weblinks are filtered out of listings.
  readonly sizesAlwaysKnown: boolean = true
  override readonly indexTtl: number = 86_400
  readonly prompt: string = BOX_PROMPT
  readonly config: BoxConfig
  readonly accessor: BoxAccessor

  constructor(config: BoxConfig) {
    super()
    this.config = config
    // The whole config goes to the token manager, never a hand-picked
    // subset: a field added to BoxConfig would silently stop reaching it
    // (that is how gdrive lost apiBase and kept refreshing at the real
    // Google endpoint against a fake server).
    const tm = new BoxTokenManager(config)
    this.accessor = new BoxAccessor({
      tokenManager: tm,
      ...(config.rootFolderId !== undefined ? { rootFolderId: config.rootFolderId } : {}),
      ...(config.contentSearch !== undefined ? { contentSearch: config.contentSearch } : {}),
    })
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return BOX_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return BOX_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return boxRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return boxReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return boxStat(this.accessor, p, this.index)
  }

  glob(paths: readonly PathSpec[], prefix = ''): Promise<PathSpec[]> {
    const effective =
      prefix !== ''
        ? paths.map((p) =>
            mountPrefixOf(p.virtual, p.vfsPath) !== ''
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
    return boxResolveGlob(this.accessor, effective, this.index)
  }

  deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override getState(): Promise<BoxVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactBoxConfig(this.config),
    })
  }

  override loadState(_state: BoxVFSState): Promise<void> {
    return Promise.resolve()
  }
}
