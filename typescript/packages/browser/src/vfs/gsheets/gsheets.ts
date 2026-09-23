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

import { GSheetsAccessor } from '@struktoai/mirage-core/accessor/gsheets'
import { makeResolveGlob } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import { GSHEETS_COMMANDS } from '@struktoai/mirage-core/commands/builtin/gsheets/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { TokenManager } from '@struktoai/mirage-core/core/google/client'
import { read as gsheetsRead } from '@struktoai/mirage-core/core/gsheets/read'
import { readdir as gsheetsReaddir } from '@struktoai/mirage-core/core/gsheets/readdir'
import { stat as gsheetsStat } from '@struktoai/mirage-core/core/gsheets/stat'
import { GSHEETS_OPS } from '@struktoai/mirage-core/ops/gsheets/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import type { VFS } from '@struktoai/mirage-core/vfs/base'
import { GSHEETS_PROMPT, GSHEETS_WRITE_PROMPT } from '@struktoai/mirage-core/vfs/gsheets/prompt'
import { PathSpec, VFSName } from '@struktoai/mirage-core/types'
import type { FileStat } from '@struktoai/mirage-core/types'
import { mountKey, mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import {
  redactGSheetsConfig,
  type GSheetsConfig,
  type GSheetsConfigRedacted,
} from '@struktoai/mirage-core/vfs/gsheets/config'

const gsheetsResolveGlob = makeResolveGlob(gsheetsReaddir)

export interface GSheetsVFSState {
  type: string
  config: GSheetsConfigRedacted
}

export class GSheetsVFS extends BaseVFS implements VFS {
  readonly kind: string = VFSName.GSHEETS
  readonly cachesReads: boolean = true
  override readonly indexTtl: number = 86_400
  readonly prompt: string = GSHEETS_PROMPT
  readonly writePrompt: string = GSHEETS_WRITE_PROMPT
  readonly config: GSheetsConfig
  readonly accessor: GSheetsAccessor

  constructor(config: GSheetsConfig) {
    super()
    this.config = config
    const tm = new TokenManager(config)
    this.accessor = new GSheetsAccessor({ tokenManager: tm })
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return GSHEETS_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return GSHEETS_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return gsheetsRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return gsheetsReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return gsheetsStat(this.accessor, p, this.index)
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
    return gsheetsResolveGlob(this.accessor, effective, this.index)
  }

  override getState(): Promise<GSheetsVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactGSheetsConfig(this.config),
    })
  }

  override loadState(_state: GSheetsVFSState): Promise<void> {
    return Promise.resolve()
  }
}
