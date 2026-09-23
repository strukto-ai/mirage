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

import { SlackAccessor } from '@struktoai/mirage-core/accessor/slack'
import { makeResolveGlob } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import { SLACK_COMMANDS } from '@struktoai/mirage-core/commands/builtin/slack/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { BrowserSlackTransport } from '@struktoai/mirage-core/core/slack/client_browser'
import { read as slackRead } from '@struktoai/mirage-core/core/slack/read'
import { readdir as slackReaddir } from '@struktoai/mirage-core/core/slack/readdir'
import { stat as slackStat } from '@struktoai/mirage-core/core/slack/stat'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { SLACK_OPS } from '@struktoai/mirage-core/ops/slack/index'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import type { VFS } from '@struktoai/mirage-core/vfs/base'
import { SLACK_PROMPT, SLACK_WRITE_PROMPT } from '@struktoai/mirage-core/vfs/slack/prompt'
import { PathSpec, VFSName } from '@struktoai/mirage-core/types'
import type { FileStat } from '@struktoai/mirage-core/types'
import { mountKey, mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import { redactSlackConfig, type SlackConfig, type SlackConfigRedacted } from './config.ts'

const resolveSlackGlob = makeResolveGlob(slackReaddir)

export interface SlackVFSState {
  type: string
  config: SlackConfigRedacted
}

export class SlackVFS extends BaseVFS implements VFS {
  readonly kind: string = VFSName.SLACK
  readonly cachesReads: boolean = true
  // Every listed file carries an exact size: chat.jsonl and users/*.json
  // are rendered at readdir from payloads the listing already fetched
  // (users.list is payload-identical to users.info, verified live), and
  // file blobs carry Slack's upload byte count.
  readonly sizesAlwaysKnown: boolean = true
  override readonly indexTtl: number = 600
  readonly prompt: string = SLACK_PROMPT
  readonly writePrompt: string = SLACK_WRITE_PROMPT
  readonly config: SlackConfig
  readonly accessor: SlackAccessor

  constructor(config: SlackConfig) {
    super()
    this.config = config
    this.accessor = new SlackAccessor(
      new BrowserSlackTransport({
        proxyUrl: config.proxyUrl,
        ...(config.getHeaders !== undefined ? { getHeaders: config.getHeaders } : {}),
      }),
    )
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return SLACK_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return SLACK_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return slackRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return slackReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return slackStat(this.accessor, p, this.index)
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
    return resolveSlackGlob(this.accessor, effective, this.index)
  }

  override getState(): Promise<SlackVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactSlackConfig(this.config),
    })
  }

  override loadState(_state: SlackVFSState): Promise<void> {
    return Promise.resolve()
  }
}
