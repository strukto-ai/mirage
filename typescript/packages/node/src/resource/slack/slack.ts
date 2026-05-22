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
  type FileStat,
  NodeSlackTransport,
  PathSpec,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
  ResourceName,
  resolveSlackGlob,
  SLACK_COMMANDS,
  SLACK_PROMPT,
  SLACK_VFS_OPS,
  SLACK_WRITE_PROMPT,
  SlackAccessor,
  slackRead,
  slackReaddir,
  slackStat,
} from '@struktoai/mirage-core'
import { redactSlackConfig, type SlackConfig, type SlackConfigRedacted } from './config.ts'

export interface SlackResourceState {
  type: string
  config: SlackConfigRedacted
}

export class SlackResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.SLACK
  readonly isRemote: boolean = true
  readonly indexTtl: number = 600
  readonly prompt: string = SLACK_PROMPT
  readonly writePrompt: string = SLACK_WRITE_PROMPT
  readonly config: SlackConfig
  readonly accessor: SlackAccessor

  constructor(config: SlackConfig) {
    super()
    this.config = config
    this.accessor = new SlackAccessor(new NodeSlackTransport(config.token, config.searchToken))
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return SLACK_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return SLACK_VFS_OPS
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

  async fingerprint(p: PathSpec): Promise<string | null> {
    const lookup = await this.index.get(p.original)
    return lookup.entry?.remoteTime ?? null
  }

  glob(paths: readonly PathSpec[], prefix = ''): Promise<PathSpec[]> {
    const effective =
      prefix !== ''
        ? paths.map((p) =>
            p.prefix !== ''
              ? p
              : new PathSpec({
                  original: p.original,
                  directory: p.directory,
                  ...(p.pattern !== null ? { pattern: p.pattern } : {}),
                  resolved: p.resolved,
                  prefix,
                }),
          )
        : paths
    return resolveSlackGlob(this.accessor, effective, this.index)
  }

  getState(): Promise<SlackResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactSlackConfig(this.config),
    })
  }

  loadState(_state: SlackResourceState): Promise<void> {
    return Promise.resolve()
  }
}
