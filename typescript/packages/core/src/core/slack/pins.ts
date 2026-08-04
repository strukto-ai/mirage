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

import type { SlackAccessor } from '../../accessor/slack.ts'
import type { SlackResponse } from './_client.ts'

export async function pinMessage(
  accessor: SlackAccessor,
  channelId: string,
  timestamp: string,
): Promise<SlackResponse> {
  return accessor.transport.call('pins.add', undefined, {
    channel: channelId,
    timestamp,
  })
}

export async function unpinMessage(
  accessor: SlackAccessor,
  channelId: string,
  timestamp: string,
): Promise<SlackResponse> {
  return accessor.transport.call('pins.remove', undefined, {
    channel: channelId,
    timestamp,
  })
}

export async function listPins(
  accessor: SlackAccessor,
  channelId: string,
): Promise<Record<string, unknown>[]> {
  const data = await accessor.transport.call('pins.list', { channel: channelId })
  const items = data.items
  return Array.isArray(items) ? (items as Record<string, unknown>[]) : []
}
