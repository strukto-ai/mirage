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
import { ResponseCache } from './responses.ts'
import { LISTING_TRUST_WINDOW } from '../cache/index/constants.ts'
import { TimeRange } from '../core/time_range.ts'
import type { BaseVFS } from '../vfs/base.ts'
import { NodeDiscordTransport, type DiscordTransport } from '../core/discord/client.ts'
import type { DiscordConfig } from '../core/discord/config.ts'

export class DiscordAccessor extends Accessor {
  readonly timeRange: TimeRange
  readonly timeout: number | undefined
  readonly listedDay = new ResponseCache<string, Record<string, unknown>[]>(LISTING_TRUST_WINDOW)
  constructor(
    public readonly transport: DiscordTransport,
    config: { startTime?: string | null; endTime?: string | null; timeout?: number } = {},
  ) {
    super()
    this.timeRange = new TimeRange(config.startTime, config.endTime)
    this.timeout = config.timeout
  }

  override caches(): readonly ResponseCache<unknown, unknown>[] {
    return [this.listedDay]
  }
}

/**
 * The `discord` CLI's accessor factory: the registry builds one per install
 * from its validated config, so every verb of that install rides one
 * transport. Python passes `DiscordAccessor` itself.
 */
export function discordAccessor(config: unknown): DiscordAccessor {
  const cfg = config as DiscordConfig
  return new DiscordAccessor(new NodeDiscordTransport(cfg.token, cfg.baseUrl, cfg.timeout))
}

export interface DiscordResourceLike extends BaseVFS {
  readonly accessor: DiscordAccessor
}
