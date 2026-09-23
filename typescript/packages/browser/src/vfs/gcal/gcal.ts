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

import { GCalAccessor } from '@struktoai/mirage-core/accessor/gcal'
import { GCAL_COMMANDS } from '@struktoai/mirage-core/commands/builtin/gcal/index'
import { makeResolveGlob } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { read as gcalRead } from '@struktoai/mirage-core/core/gcal/read'
import { readdir as gcalReaddir } from '@struktoai/mirage-core/core/gcal/readdir'
import { stat as gcalStat } from '@struktoai/mirage-core/core/gcal/stat'
import { TokenManager } from '@struktoai/mirage-core/core/google/client'
import { GCAL_OPS } from '@struktoai/mirage-core/ops/gcal/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import type { VFS } from '@struktoai/mirage-core/vfs/base'
import { GCAL_PROMPT, GCAL_WRITE_PROMPT } from '@struktoai/mirage-core/vfs/gcal/prompt'
import { PathSpec, VFSName } from '@struktoai/mirage-core/types'
import type { FileStat } from '@struktoai/mirage-core/types'
import { mountKey, mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import {
  redactGCalConfig,
  type GCalConfig,
  type GCalConfigRedacted,
} from '@struktoai/mirage-core/vfs/gcal/config'

const gcalResolveGlob = makeResolveGlob(gcalReaddir)

export interface GCalVFSState {
  type: string
  config: GCalConfigRedacted
}

export class GCalVFS extends BaseVFS implements VFS {
  readonly kind: string = VFSName.GCAL
  readonly cachesReads: boolean = true
  // Shorter than the other Google mounts: a calendar is edited by other
  // people and a day-long index would keep serving a schedule that has
  // already moved.
  override readonly indexTtl: number = 300
  readonly prompt: string = GCAL_PROMPT
  readonly writePrompt: string = GCAL_WRITE_PROMPT
  readonly config: GCalConfig
  readonly accessor: GCalAccessor

  constructor(config: GCalConfig) {
    super()
    this.config = config
    const tm = new TokenManager(config)
    this.accessor = new GCalAccessor({ tokenManager: tm, config })
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return GCAL_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return GCAL_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return gcalRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return gcalReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return gcalStat(this.accessor, p, this.index)
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
    return gcalResolveGlob(this.accessor, effective, this.index)
  }

  override getState(): Promise<GCalVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactGCalConfig(this.config),
    })
  }

  override loadState(_state: GCalVFSState): Promise<void> {
    return Promise.resolve()
  }
}
