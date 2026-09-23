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

import { TrelloAccessor } from '@struktoai/mirage-core/accessor/trello'
import { makeResolveGlob } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import { TRELLO_COMMANDS } from '@struktoai/mirage-core/commands/builtin/trello/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { HttpTrelloTransport } from '@struktoai/mirage-core/core/trello/client'
import { read as trelloRead } from '@struktoai/mirage-core/core/trello/read'
import { readdir as trelloReaddir } from '@struktoai/mirage-core/core/trello/readdir'
import { stat as trelloStat } from '@struktoai/mirage-core/core/trello/stat'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { TRELLO_OPS } from '@struktoai/mirage-core/ops/trello/index'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import type { VFS } from '@struktoai/mirage-core/vfs/base'
import { TRELLO_PROMPT, TRELLO_WRITE_PROMPT } from '@struktoai/mirage-core/vfs/trello/prompt'
import { PathSpec, VFSName } from '@struktoai/mirage-core/types'
import type { FileStat } from '@struktoai/mirage-core/types'
import { mountKey, mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import { redactTrelloConfig, type TrelloConfig, type TrelloConfigRedacted } from './config.ts'

const resolveTrelloGlob = makeResolveGlob(trelloReaddir)

export interface TrelloVFSState {
  type: string
  config: TrelloConfigRedacted
}

export class TrelloVFS extends BaseVFS implements VFS {
  readonly kind: string = VFSName.TRELLO
  readonly cachesReads: boolean = true
  override readonly indexTtl: number = 600
  readonly prompt: string = TRELLO_PROMPT
  readonly writePrompt: string = TRELLO_WRITE_PROMPT
  readonly config: TrelloConfig
  readonly accessor: TrelloAccessor

  constructor(config: TrelloConfig) {
    super()
    this.config = config
    const transportOpts: { apiKey: string; apiToken: string; baseUrl?: string } = {
      apiKey: config.apiKey,
      apiToken: config.apiToken,
    }
    if (config.baseUrl !== undefined) transportOpts.baseUrl = config.baseUrl
    const accessorOpts: { workspaceId?: string; boardIds?: readonly string[] } = {}
    if (config.workspaceId !== undefined) accessorOpts.workspaceId = config.workspaceId
    if (config.boardIds !== undefined) accessorOpts.boardIds = config.boardIds
    this.accessor = new TrelloAccessor(new HttpTrelloTransport(transportOpts), accessorOpts)
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return TRELLO_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return TRELLO_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return trelloRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return trelloReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return trelloStat(this.accessor, p, this.index)
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
    return resolveTrelloGlob(this.accessor, effective, this.index)
  }

  override getState(): Promise<TrelloVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactTrelloConfig(this.config),
    })
  }

  override loadState(_state: TrelloVFSState): Promise<void> {
    return Promise.resolve()
  }
}
