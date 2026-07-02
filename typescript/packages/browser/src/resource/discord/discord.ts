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
  BrowserDiscordTransport,
  DISCORD_COMMANDS,
  DISCORD_PROMPT,
  DISCORD_VFS_OPS,
  DISCORD_WRITE_PROMPT,
  DiscordAccessor,
  type FileStat,
  type IndexCacheStore,
  PathSpec,
  RAMIndexCacheStore,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
  ResourceName,
  discordRead,
  discordReaddir,
  discordStat,
  resolveDiscordGlob,
} from '@struktoai/mirage-core'
import { redactDiscordConfig, type DiscordConfig, type DiscordConfigRedacted } from './config.ts'

export interface DiscordResourceState {
  type: string
  config: DiscordConfigRedacted
}

export class DiscordResource implements Resource {
  readonly kind: string = ResourceName.DISCORD
  readonly cachesReads: boolean = true
  readonly indexTtl: number = 600
  readonly prompt: string = DISCORD_PROMPT
  readonly writePrompt: string = DISCORD_WRITE_PROMPT
  readonly config: DiscordConfig
  readonly accessor: DiscordAccessor
  readonly index: IndexCacheStore

  constructor(config: DiscordConfig) {
    this.config = config
    this.accessor = new DiscordAccessor(
      new BrowserDiscordTransport({
        proxyUrl: config.proxyUrl,
        ...(config.getHeaders !== undefined ? { getHeaders: config.getHeaders } : {}),
      }),
    )
    this.index = new RAMIndexCacheStore({ ttl: this.indexTtl })
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return DISCORD_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return DISCORD_VFS_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return discordRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return discordReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return discordStat(this.accessor, p, this.index)
  }

  async fingerprint(p: PathSpec): Promise<string | null> {
    const lookup = await this.index.get(p.virtual)
    return lookup.entry?.remoteTime ?? null
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
    return resolveDiscordGlob(this.accessor, effective, this.index)
  }

  getState(): Promise<DiscordResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactDiscordConfig(this.config),
    })
  }

  loadState(_state: DiscordResourceState): Promise<void> {
    return Promise.resolve()
  }
}
