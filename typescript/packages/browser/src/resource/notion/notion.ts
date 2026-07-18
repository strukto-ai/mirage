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

import { mountKey, mountPrefixOf } from '@struktoai/mirage-core'
import {
  type FileStat,
  type IndexCacheStore,
  MCPNotionTransport,
  type MCPNotionTransportOptions,
  NOTION_COMMANDS,
  NOTION_PROMPT,
  NOTION_OPS,
  NOTION_WRITE_PROMPT,
  NotionAccessor,
  notionRead,
  notionReaddir,
  notionStat,
  PathSpec,
  RAMIndexCacheStore,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
  ResourceName,
  makeResolveGlob,
} from '@struktoai/mirage-core'
import { redactNotionConfig, type NotionConfig, type NotionConfigRedacted } from './config.ts'

const resolveNotionGlob = makeResolveGlob<NotionAccessor>(notionReaddir)

export interface NotionResourceState {
  type: string
  config: NotionConfigRedacted
}

export class NotionResource implements Resource {
  readonly kind: string = ResourceName.NOTION
  readonly cachesReads: boolean = true
  readonly indexTtl: number = 600
  readonly prompt: string = NOTION_PROMPT
  readonly writePrompt: string = NOTION_WRITE_PROMPT
  readonly config: NotionConfig
  readonly accessor: NotionAccessor
  readonly index: IndexCacheStore

  constructor(config: NotionConfig) {
    this.config = config
    const opts: MCPNotionTransportOptions = { authProvider: config.authProvider }
    if (config.serverUrl !== undefined) opts.serverUrl = config.serverUrl
    this.accessor = new NotionAccessor(new MCPNotionTransport(opts))
    this.index = new RAMIndexCacheStore({ ttl: this.indexTtl })
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return NOTION_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return NOTION_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return notionRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return notionReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return notionStat(this.accessor, p, this.index)
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
    return resolveNotionGlob(this.accessor, effective, this.index)
  }

  getState(): Promise<NotionResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactNotionConfig(this.config),
    })
  }

  loadState(_state: NotionResourceState): Promise<void> {
    return Promise.resolve()
  }
}
