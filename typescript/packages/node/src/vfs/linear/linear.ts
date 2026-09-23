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

import { LinearAccessor } from '@struktoai/mirage-core/accessor/linear'
import { makeResolveGlob } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import { LINEAR_COMMANDS } from '@struktoai/mirage-core/commands/builtin/linear/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { HttpLinearTransport } from '@struktoai/mirage-core/core/linear/client'
import { redactLinearConfig } from '@struktoai/mirage-core/core/linear/config'
import type { LinearConfig, LinearConfigRedacted } from '@struktoai/mirage-core/core/linear/config'
import { read as linearRead } from '@struktoai/mirage-core/core/linear/read'
import { readdir as linearReaddir } from '@struktoai/mirage-core/core/linear/readdir'
import { stat as linearStat } from '@struktoai/mirage-core/core/linear/stat'
import { LINEAR_OPS } from '@struktoai/mirage-core/ops/linear/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import type { VFS } from '@struktoai/mirage-core/vfs/base'
import { LINEAR_PROMPT, LINEAR_WRITE_PROMPT } from '@struktoai/mirage-core/vfs/linear/prompt'
import { PathSpec, VFSName } from '@struktoai/mirage-core/types'
import type { FileStat } from '@struktoai/mirage-core/types'
import { mountKey, mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'

const resolveLinearGlob = makeResolveGlob(linearReaddir)

export interface LinearVFSState {
  type: string
  config: LinearConfigRedacted
}

export class LinearVFS extends BaseVFS implements VFS {
  readonly kind: string = VFSName.LINEAR
  readonly cachesReads: boolean = true
  // Every file is sized at its parent's readdir from the listing payload
  // (comments.jsonl via one bounded comments call), so stat always reports
  // the rendered byte length and fskit mounts serve exact reads.
  readonly sizesAlwaysKnown: boolean = true
  override readonly indexTtl: number = 600
  readonly prompt: string = LINEAR_PROMPT
  readonly writePrompt: string = LINEAR_WRITE_PROMPT
  readonly config: LinearConfig
  readonly accessor: LinearAccessor

  constructor(config: LinearConfig) {
    super()
    this.config = config
    const transportOpts: { apiKey: string; baseUrl?: string } = { apiKey: config.apiKey }
    if (config.baseUrl !== undefined) transportOpts.baseUrl = config.baseUrl
    const accessorOpts: { teamIds?: readonly string[] } = {}
    if (config.teamIds !== undefined) accessorOpts.teamIds = config.teamIds
    this.accessor = new LinearAccessor(new HttpLinearTransport(transportOpts), accessorOpts)
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return LINEAR_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return LINEAR_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return linearRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return linearReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return linearStat(this.accessor, p, this.index)
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
    return resolveLinearGlob(this.accessor, effective, this.index)
  }

  override getState(): Promise<LinearVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactLinearConfig(this.config),
    })
  }

  override loadState(_state: LinearVFSState): Promise<void> {
    return Promise.resolve()
  }
}
