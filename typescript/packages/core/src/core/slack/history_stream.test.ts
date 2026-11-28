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

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { HISTORY, SlackWorkspace } from '../../../tests/core/slack/workspace.ts'
import { fetchMessagesForDay, streamMessagesForDay } from './history.ts'

let origin = ''
let workspace: SlackWorkspace

beforeAll(async () => {
  origin = await serve('slack')
})

beforeEach(async () => {
  workspace = new SlackWorkspace(origin)
  await workspace.reset()
})

afterEach(async () => {
  await workspace.close()
})

// general's first day: the deploy at 00:01, then ben's coffee at 01:00.
const DEPLOY = '1762128060.000001'
const COFFEE = '1762131600.000001'
const DAY = {
  channel: 'C1',
  oldest: '1762128000.000000',
  latest: '1762214400.000000',
  inclusive: 'true',
}

describe('streamMessagesForDay', () => {
  it('paginates conversations.history for the channel/day', async () => {
    // Slack's first page holds one message, newest first, so the day comes in
    // two pages.
    await workspace.firstPage(HISTORY, 1, DAY)
    const result: string[][] = []
    for await (const page of streamMessagesForDay(workspace.accessor(), 'C1', '2025-11-03')) {
      result.push(page.map((m) => m.ts))
    }
    expect(result).toEqual([[COFFEE], [DEPLOY]])
    expect((await workspace.run.params('GET', HISTORY))[0]).toMatchObject({ ...DAY, limit: '200' })
  })
})

describe('fetchMessagesForDay (eager + sort)', () => {
  it('sorts by ts ascending across pages', async () => {
    await workspace.firstPage(HISTORY, 1, DAY)
    const msgs = await fetchMessagesForDay(workspace.accessor(), 'C1', '2025-11-03')
    expect(msgs.map((m) => m.ts)).toEqual([DEPLOY, COFFEE])
  })
})
