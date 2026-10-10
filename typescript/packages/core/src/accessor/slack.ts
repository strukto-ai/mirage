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

import { Accessor } from './base.ts'
import { TimeRange } from '../core/time_range.ts'
import type { BaseVFS } from '../vfs/base.ts'
import { NodeSlackTransport, type SlackTransport } from '../core/slack/client.ts'
import type { SlackConfig } from '../core/slack/config.ts'

export class SlackAccessor extends Accessor {
  readonly timeRange: TimeRange
  readonly contentSearch: boolean
  // The words of the workspace's names and the channels search covers while a
  // search fetches them, so the patterns of one grep share one users.list and
  // one channel listing.
  searchFacts: Promise<[ReadonlySet<string>, ReadonlySet<string> | null]> | null = null
  constructor(
    public readonly transport: SlackTransport,
    config: { startTime?: string | null; endTime?: string | null; contentSearch?: boolean } = {},
  ) {
    super()
    this.timeRange = new TimeRange(config.startTime, config.endTime)
    this.contentSearch = config.contentSearch === true
  }
}

/**
 * The accessor the `slack` CLI's verbs reach the API through, built from
 * the install's config. Python's verbs hand the config to core directly;
 * here core takes an accessor.
 */
export function slackAccessor(config: unknown): SlackAccessor {
  const cfg = config as SlackConfig
  return new SlackAccessor(new NodeSlackTransport(cfg.token, cfg.searchToken, cfg.baseUrl))
}

export interface SlackResourceLike extends BaseVFS {
  readonly accessor: SlackAccessor
}
