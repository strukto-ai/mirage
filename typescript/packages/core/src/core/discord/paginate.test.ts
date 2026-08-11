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

import { describe, expect, it } from 'vitest'
import { DiscordAccessor } from '../../accessor/discord.ts'
import type { DiscordMethod, DiscordResponse, DiscordTransport } from './_client.ts'
import { afterIdPages } from './paginate.ts'

class PageTransport implements DiscordTransport {
  readonly afters: string[] = []
  constructor(private readonly pages: Record<string, { id: string }[]>) {}
  call(
    _method: DiscordMethod,
    _endpoint: string,
    params?: Record<string, string | number>,
  ): Promise<DiscordResponse> {
    const after = String(params?.after ?? '')
    this.afters.push(after)
    return Promise.resolve(this.pages[after] ?? [])
  }
}

async function drain(iter: AsyncIterableIterator<{ id: string }[]>): Promise<string[]> {
  const ids: string[] = []
  for await (const page of iter) for (const item of page) ids.push(item.id)
  return ids
}

describe('afterIdPages', () => {
  it('advances with the newest id on a newest-first endpoint', async () => {
    // Discord answers GET /channels/{id}/messages newest-first, so the cursor
    // is the first item; taking the last one re-requests the same window.
    const transport = new PageTransport({
      '0': [{ id: '200' }, { id: '199' }],
      '200': [{ id: '300' }],
    })
    const ids = await drain(
      afterIdPages<{ id: string }>(new DiscordAccessor(transport), {
        endpoint: '/channels/C/messages',
        lastIdFn: (m) => (m as { id: string }).id,
        pageSize: 2,
        newestFirst: true,
      }),
    )
    expect(transport.afters).toEqual(['0', '200'])
    expect(ids).toEqual(['200', '199', '300'])
  })

  it('advances with the last id by default', async () => {
    // Members and guilds come back ascending, so the newest id is the last.
    const transport = new PageTransport({
      '0': [{ id: '1' }, { id: '2' }],
      '2': [{ id: '3' }],
    })
    const ids = await drain(
      afterIdPages<{ id: string }>(new DiscordAccessor(transport), {
        endpoint: '/guilds/G/members',
        lastIdFn: (m) => (m as { id: string }).id,
        pageSize: 2,
      }),
    )
    expect(transport.afters).toEqual(['0', '2'])
    expect(ids).toEqual(['1', '2', '3'])
  })
})
