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

import { GDocsAccessor } from '@struktoai/mirage-core/accessor/gdocs'
import { GDOCS_COMMANDS } from '@struktoai/mirage-core/commands/builtin/gdocs/index'
import { makeResolveGlob } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { read as gdocsRead } from '@struktoai/mirage-core/core/gdocs/read'
import { readdir as gdocsReaddir } from '@struktoai/mirage-core/core/gdocs/readdir'
import { stat as gdocsStat } from '@struktoai/mirage-core/core/gdocs/stat'
import { TokenManager } from '@struktoai/mirage-core/core/google/client'
import { GDOCS_OPS } from '@struktoai/mirage-core/ops/gdocs/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import type { VFS } from '@struktoai/mirage-core/vfs/base'
import { GDOCS_PROMPT, GDOCS_WRITE_PROMPT } from '@struktoai/mirage-core/vfs/gdocs/prompt'
import { PathSpec, VFSName } from '@struktoai/mirage-core/types'
import type { FileStat } from '@struktoai/mirage-core/types'
import { mountKey, mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import {
  redactGDocsConfig,
  type GDocsConfig,
  type GDocsConfigRedacted,
} from '@struktoai/mirage-core/vfs/gdocs/config'

const gdocsResolveGlob = makeResolveGlob(gdocsReaddir)

export interface GDocsVFSState {
  type: string
  config: GDocsConfigRedacted
}

export class GDocsVFS extends BaseVFS implements VFS {
  readonly kind: string = VFSName.GDOCS
  readonly cachesReads: boolean = true
  override readonly indexTtl: number = 86_400
  readonly prompt: string = GDOCS_PROMPT
  readonly writePrompt: string = GDOCS_WRITE_PROMPT
  readonly config: GDocsConfig
  readonly accessor: GDocsAccessor

  constructor(config: GDocsConfig) {
    super()
    this.config = config
    const tm = new TokenManager(config)
    this.accessor = new GDocsAccessor({ tokenManager: tm })
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return GDOCS_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return GDOCS_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return gdocsRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return gdocsReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return gdocsStat(this.accessor, p, this.index)
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
    return gdocsResolveGlob(this.accessor, effective, this.index)
  }

  override getState(): Promise<GDocsVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactGDocsConfig(this.config),
    })
  }

  override loadState(_state: GDocsVFSState): Promise<void> {
    return Promise.resolve()
  }
}
