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

import { SlackVFSBase } from '@struktoai/mirage-core/vfs/slack/slack'
import { SlackAccessor } from '@struktoai/mirage-core/accessor/slack'

import { NodeSlackTransport } from '@struktoai/mirage-core/core/slack/client'
import { redactSlackConfig } from '@struktoai/mirage-core/vfs/slack/config'
import type { SlackConfig, SlackConfigRedacted } from '@struktoai/mirage-core/vfs/slack/config'

import { VFS_MD } from '@struktoai/mirage-core/vfs/slack/slack'
import { VFSName } from '@struktoai/mirage-core/types'
import { WALK_LIMIT } from '@struktoai/mirage-core/vfs/constants'

export interface SlackVFSState {
  type: string
  config: SlackConfigRedacted
}

export class SlackVFS extends SlackVFSBase {
  override readonly name: string = VFSName.SLACK
  override readonly cachesReads: boolean = true
  // Every listed file carries an exact size: chat.jsonl and users/*.json
  // are rendered at readdir from payloads the listing already fetched
  // (users.list is payload-identical to users.info, verified live), and
  // file blobs carry Slack's upload byte count.
  override readonly sizesAlwaysKnown: boolean = true
  override vfsMd: string
  readonly config: SlackConfig
  override readonly accessor: SlackAccessor

  override readonly walkLimit: number

  constructor(config: SlackConfig) {
    super()
    this.config = config
    this.walkLimit = config.walkLimit ?? WALK_LIMIT
    this.accessor = new SlackAccessor(
      new NodeSlackTransport(config.token, config.searchToken, config.baseUrl),
      config,
    )
    this.vfsMd = VFS_MD + this.accessor.timeRange.vfsMd()
  }

  override getState(): Promise<SlackVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactSlackConfig(this.config),
    })
  }
}
