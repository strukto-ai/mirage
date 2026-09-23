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

import { GSlidesAccessor } from '@struktoai/mirage-core/accessor/gslides'
import { makeResolveGlob } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import { GSLIDES_COMMANDS } from '@struktoai/mirage-core/commands/builtin/gslides/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { TokenManager } from '@struktoai/mirage-core/core/google/client'
import { read as gslidesRead } from '@struktoai/mirage-core/core/gslides/read'
import { readdir as gslidesReaddir } from '@struktoai/mirage-core/core/gslides/readdir'
import { stat as gslidesStat } from '@struktoai/mirage-core/core/gslides/stat'
import { GSLIDES_OPS } from '@struktoai/mirage-core/ops/gslides/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import type { VFS } from '@struktoai/mirage-core/vfs/base'
import { GSLIDES_PROMPT, GSLIDES_WRITE_PROMPT } from '@struktoai/mirage-core/vfs/gslides/prompt'
import { PathSpec, VFSName } from '@struktoai/mirage-core/types'
import type { FileStat } from '@struktoai/mirage-core/types'
import { mountKey, mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import {
  redactGSlidesConfig,
  type GSlidesConfig,
  type GSlidesConfigRedacted,
} from '@struktoai/mirage-core/vfs/gslides/config'

const gslidesResolveGlob = makeResolveGlob(gslidesReaddir)

export interface GSlidesVFSState {
  type: string
  config: GSlidesConfigRedacted
}

export class GSlidesVFS extends BaseVFS implements VFS {
  readonly kind: string = VFSName.GSLIDES
  readonly cachesReads: boolean = true
  override readonly indexTtl: number = 86_400
  readonly prompt: string = GSLIDES_PROMPT
  readonly writePrompt: string = GSLIDES_WRITE_PROMPT
  readonly config: GSlidesConfig
  readonly accessor: GSlidesAccessor

  constructor(config: GSlidesConfig) {
    super()
    this.config = config
    const tm = new TokenManager(config)
    this.accessor = new GSlidesAccessor({ tokenManager: tm })
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return GSLIDES_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return GSLIDES_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return gslidesRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return gslidesReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return gslidesStat(this.accessor, p, this.index)
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
    return gslidesResolveGlob(this.accessor, effective, this.index)
  }

  override getState(): Promise<GSlidesVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactGSlidesConfig(this.config),
    })
  }

  override loadState(_state: GSlidesVFSState): Promise<void> {
    return Promise.resolve()
  }
}
