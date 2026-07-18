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

import {
  BaseResource,
  HttpTrelloTransport,
  PathSpec,
  ResourceName,
  TRELLO_COMMANDS,
  TRELLO_PROMPT,
  TRELLO_VFS_OPS,
  TRELLO_WRITE_PROMPT,
  TrelloAccessor,
  makeResolveGlob,
  mountKey,
  mountPrefixOf,
  trelloRead,
  trelloReaddir,
  trelloStat,
  type FileStat,
  type IndexCacheStore,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
  type TrelloReaddirFilter,
} from '@struktoai/mirage-core'
import { redactTrelloConfig, type TrelloConfig, type TrelloConfigRedacted } from './config.ts'

const resolveTrelloGlob = (
  accessor: TrelloAccessor,
  paths: readonly PathSpec[],
  index: IndexCacheStore | undefined,
  filter: TrelloReaddirFilter,
): Promise<PathSpec[]> =>
  makeResolveGlob((a: TrelloAccessor, p: PathSpec, i?: IndexCacheStore) =>
    trelloReaddir(a, p, i, filter),
  )(accessor, paths, index)

export interface TrelloResourceState {
  type: string
  config: TrelloConfigRedacted
}

export class TrelloResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.TRELLO
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
    this.accessor = new TrelloAccessor(new HttpTrelloTransport(transportOpts))
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return TRELLO_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return TRELLO_VFS_OPS
  }

  private filter(): TrelloReaddirFilter {
    const out: TrelloReaddirFilter = {}
    if (this.config.workspaceId !== undefined) out.workspaceId = this.config.workspaceId
    if (this.config.boardIds !== undefined) out.boardIds = this.config.boardIds
    return out
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return trelloRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return trelloReaddir(this.accessor, p, this.index, this.filter())
  }

  stat(p: PathSpec): Promise<FileStat> {
    return trelloStat(this.accessor, p, this.index)
  }

  glob(paths: readonly PathSpec[], prefix = ''): Promise<PathSpec[]> {
    const effective =
      prefix !== ''
        ? paths.map((p) =>
            mountPrefixOf(p.virtual, p.resourcePath) !== ''
              ? p
              : new PathSpec({
                  virtual: p.virtual,
                  directory: p.directory,
                  ...(p.pattern !== null ? { pattern: p.pattern } : {}),
                  resolved: p.resolved,
                  resourcePath: mountKey(p.virtual, prefix),
                }),
          )
        : paths
    return resolveTrelloGlob(this.accessor, effective, this.index, this.filter())
  }

  getState(): Promise<TrelloResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactTrelloConfig(this.config),
    })
  }

  loadState(_state: TrelloResourceState): Promise<void> {
    return Promise.resolve()
  }
}
