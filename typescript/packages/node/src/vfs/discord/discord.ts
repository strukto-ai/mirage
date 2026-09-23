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

import { DiscordAccessor } from '@struktoai/mirage-core/accessor/discord'
import { DISCORD_COMMANDS } from '@struktoai/mirage-core/commands/builtin/discord/index'
import { makeResolveGlob } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { NodeDiscordTransport } from '@struktoai/mirage-core/core/discord/client'
import { redactDiscordConfig } from '@struktoai/mirage-core/core/discord/config'
import type {
  DiscordConfig,
  DiscordConfigRedacted,
} from '@struktoai/mirage-core/core/discord/config'
import { read as discordRead } from '@struktoai/mirage-core/core/discord/read'
import { readdir as discordReaddir } from '@struktoai/mirage-core/core/discord/readdir'
import { stat as discordStat } from '@struktoai/mirage-core/core/discord/stat'
import { DISCORD_OPS } from '@struktoai/mirage-core/ops/discord/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import type { VFS } from '@struktoai/mirage-core/vfs/base'
import { DISCORD_PROMPT, DISCORD_WRITE_PROMPT } from '@struktoai/mirage-core/vfs/discord/prompt'
import { PathSpec, VFSName } from '@struktoai/mirage-core/types'
import type { FileStat } from '@struktoai/mirage-core/types'
import { mountKey, mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'

const resolveDiscordGlob = makeResolveGlob(discordReaddir)

export interface DiscordVFSState {
  type: string
  config: DiscordConfigRedacted
}

export class DiscordVFS extends BaseVFS implements VFS {
  readonly kind: string = VFSName.DISCORD
  readonly cachesReads: boolean = true
  // Every listed file carries an exact size: chat.jsonl and members/*.json
  // are rendered at readdir from payloads the listing already fetched, and
  // attachments carry Discord's CDN byte count.
  readonly sizesAlwaysKnown: boolean = true
  override readonly indexTtl: number = 600
  readonly prompt: string = DISCORD_PROMPT
  readonly writePrompt: string = DISCORD_WRITE_PROMPT
  readonly config: DiscordConfig
  readonly accessor: DiscordAccessor

  constructor(config: DiscordConfig) {
    super()
    this.config = config
    this.accessor = new DiscordAccessor(new NodeDiscordTransport(config.token, config.baseUrl))
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return DISCORD_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return DISCORD_OPS
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
    return resolveDiscordGlob(this.accessor, effective, this.index)
  }

  override getState(): Promise<DiscordVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactDiscordConfig(this.config),
    })
  }

  override loadState(_state: DiscordVFSState): Promise<void> {
    return Promise.resolve()
  }
}
