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

import { SlackAccessor } from '../../../src/accessor/slack.ts'
import { NodeSlackTransport } from '../../../src/core/slack/client.ts'
import type { SlackConfig } from '../../../src/vfs/slack/config.ts'
import {
  type SlackFields,
  type SlackOptions,
  SlackWorkspace as KitWorkspace,
} from '../../fixtures/slack_workspace.ts'

export * from '../../fixtures/slack_workspace.ts'

/** A Slack workspace on the Slack fake, and a Mirage accessor onto it. */
export class SlackWorkspace extends KitWorkspace {
  /** A mount config on the workspace, as the user token. */
  override config(options: SlackOptions = {}): SlackConfig & SlackFields {
    return super.config(options) as SlackConfig & SlackFields
  }

  /** A Mirage accessor on the workspace, over the real HTTP transport. */
  accessor(options: SlackOptions = {}): SlackAccessor {
    const config = this.config(options)
    return new SlackAccessor(
      new NodeSlackTransport(config.token, config.searchToken, config.baseUrl, config.timeout),
      config,
    )
  }
}
