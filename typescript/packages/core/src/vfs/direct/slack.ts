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

import { SlackAccessor } from '../../accessor/slack.ts'
import { NodeSlackTransport } from '../../core/slack/client.ts'
import { VFSName } from '../../types.ts'
import type { RedactedSchema } from '../secrets.ts'
import { SlackConfig } from '../slack/config.ts'
import { SlackVFS as CoreSlackVFS, VFS_MD } from '../slack/slack.ts'
import type { ConfigState } from '../types.ts'

export class SlackVFS extends CoreSlackVFS {
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

  constructor(config: SlackConfig) {
    super()
    this.config = config
    this.accessor = new SlackAccessor(
      new NodeSlackTransport(config.token, config.searchToken, config.baseUrl, config.timeout),
      config,
    )
    this.vfsMd = VFS_MD + this.accessor.timeRange.vfsMd()
  }

  override getState(): Promise<ConfigState<RedactedSchema<typeof SlackConfig>>> {
    return Promise.resolve(this.configState(SlackConfig, this.config))
  }
}
