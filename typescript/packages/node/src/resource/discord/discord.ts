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
  DISCORD_API,
  DISCORD_COMMANDS,
  DISCORD_PROMPT,
  DISCORD_VFS_OPS,
  DISCORD_WRITE_PROMPT,
  DiscordAccessor,
  HttpDiscordTransport,
  PathSpec,
  ResourceName,
  discordRead,
  discordReaddir,
  discordStat,
  mountKey,
  mountPrefixOf,
  resolveDiscordGlob,
  type FileStat,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
} from '@struktoai/mirage-core'
import { redactDiscordConfig, type DiscordConfig, type DiscordConfigRedacted } from './config.ts'

class NodeDiscordTransport extends HttpDiscordTransport {
  constructor(private readonly token: string) {
    super()
  }
  protected baseUrl(): string {
    return DISCORD_API
  }
  protected authHeaders(): Record<string, string> {
    return { Authorization: `Bot ${this.token}` }
  }
}

export interface DiscordResourceState {
  type: string
  config: DiscordConfigRedacted
}

export class DiscordResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.DISCORD
  readonly cachesReads: boolean = true
  override readonly indexTtl: number = 600
  readonly prompt: string = DISCORD_PROMPT
  readonly writePrompt: string = DISCORD_WRITE_PROMPT
  readonly config: DiscordConfig
  readonly accessor: DiscordAccessor

  constructor(config: DiscordConfig) {
    super()
    this.config = config
    this.accessor = new DiscordAccessor(new NodeDiscordTransport(config.token))
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
