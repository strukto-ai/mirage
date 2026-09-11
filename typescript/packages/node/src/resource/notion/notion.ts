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

import { NotionAccessor } from '@struktoai/mirage-core/accessor/notion'
import { makeResolveGlob } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import { NOTION_COMMANDS } from '@struktoai/mirage-core/commands/builtin/notion/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { HttpNotionTransport } from '@struktoai/mirage-core/core/notion/client'
import { redactNotionConfig } from '@struktoai/mirage-core/core/notion/config'
import type { NotionConfig, NotionConfigRedacted } from '@struktoai/mirage-core/core/notion/config'
import { read as notionRead } from '@struktoai/mirage-core/core/notion/read'
import { readdir as notionReaddir } from '@struktoai/mirage-core/core/notion/readdir'
import { stat as notionStat } from '@struktoai/mirage-core/core/notion/stat'
import { NOTION_OPS } from '@struktoai/mirage-core/ops/notion/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseResource } from '@struktoai/mirage-core/resource/base'
import type { Resource } from '@struktoai/mirage-core/resource/base'
import { NOTION_PROMPT, NOTION_WRITE_PROMPT } from '@struktoai/mirage-core/resource/notion/prompt'
import { PathSpec, ResourceName } from '@struktoai/mirage-core/types'
import type { FileStat } from '@struktoai/mirage-core/types'
import { mountKey, mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'

const resolveNotionGlob = makeResolveGlob<NotionAccessor>(notionReaddir)

export interface NotionResourceState {
  type: string
  config: NotionConfigRedacted
}

export class NotionResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.NOTION
  readonly cachesReads: boolean = true
  override readonly indexTtl: number = 600
  readonly prompt: string = NOTION_PROMPT
  readonly writePrompt: string = NOTION_WRITE_PROMPT
  readonly config: NotionConfig
  readonly accessor: NotionAccessor

  constructor(config: NotionConfig) {
    super()
    this.config = config
    const transportOpts: { apiKey: string; baseUrl?: string; apiVersion?: string } = {
      apiKey: config.apiKey,
    }
    if (config.baseUrl !== undefined) transportOpts.baseUrl = config.baseUrl
    if (config.apiVersion !== undefined) transportOpts.apiVersion = config.apiVersion
    this.accessor = new NotionAccessor(new HttpNotionTransport(transportOpts))
  }

  open(): Promise<void> {
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

  override getState(): Promise<NotionResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactNotionConfig(this.config),
    })
  }

  override loadState(_state: NotionResourceState): Promise<void> {
    return Promise.resolve()
  }
}
