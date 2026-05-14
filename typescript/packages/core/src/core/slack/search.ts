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
import { NodeSlackTransport } from './_client.ts'
import { sanitizeName } from './entry.ts'
import type { SlackScope } from './scope.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

interface SearchMessageMatch {
  channel?: { name?: string; id?: string }
  ts?: string
  username?: string
  user?: string
  text?: string
}

interface SearchPayload {
  messages?: { matches?: SearchMessageMatch[] }
}

export async function searchMessages(
  accessor: SlackAccessor,
  query: string,
  count = 20,
  page = 1,
): Promise<Uint8Array> {
  const params: Record<string, string> = {
    query,
    count: String(count),
    page: String(page),
    sort: 'timestamp',
  }
  let effective = accessor
  if (accessor.transport instanceof NodeSlackTransport) {
    const searchToken = accessor.transport.getSearchToken()
    if (searchToken !== undefined && searchToken !== '') {
      effective = new SlackAccessor(new NodeSlackTransport(searchToken))
    }
  }
  const data = await effective.transport.call('search.messages', params)
  return ENC.encode(JSON.stringify(data))
}

export function buildQuery(pattern: string, scope: SlackScope): string {
  if (
    scope.container === 'channels' &&
    scope.channelName !== undefined &&
    scope.channelName !== ''
  ) {
    return `in:#${scope.channelName} ${pattern}`
  }
  if (scope.container === 'dms' && scope.channelName !== undefined && scope.channelName !== '') {
    return `in:@${scope.channelName} ${pattern}`
  }
  return pattern
}

export function formatGrepResults(raw: Uint8Array, scope: SlackScope, prefix: string): string[] {
  const payload = JSON.parse(DEC.decode(raw)) as SearchPayload
  const matches = payload.messages?.matches ?? []
  const lines: string[] = []
  for (const msg of matches) {
    const ch = msg.channel ?? {}
    const chName = ch.name ?? scope.channelName ?? ''
    const chId = ch.id ?? scope.channelId ?? ''
    const container = scope.container ?? 'channels'
    const tsRaw = msg.ts ?? '0'
    const tsFloat = Number.parseFloat(tsRaw)
    let dateStr = ''
    if (Number.isFinite(tsFloat)) {
      const dateIso = new Date(tsFloat * 1000).toISOString()
      dateStr = dateIso.slice(0, 10)
    }
    const dirname = chId !== '' ? `${sanitizeName(chName)}__${chId}` : sanitizeName(chName)
    const path =
      dateStr !== ''
        ? `${prefix}/${container}/${dirname}/${dateStr}.jsonl`
        : `${prefix}/${container}/${dirname}`
    const author = msg.username ?? msg.user ?? '?'
    const text = (msg.text ?? '').replaceAll('\n', ' ')
    lines.push(`${path}:[${author}] ${text}`)
  }
  return lines
}
