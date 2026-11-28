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
import { fetchRecentMessages, getHistoryJsonl } from './history.ts'

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
const DAY = {
  channel: 'C1',
  oldest: '1762128000.000000',
  latest: '1762214400.000000',
  inclusive: 'true',
}
const decoder = new TextDecoder()

function texts(bytes: Uint8Array): string[] {
  return decoder
    .decode(bytes)
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { text: string }).text)
}

describe('getHistoryJsonl', () => {
  it('returns JSONL bytes with one message per line, trailing newline', async () => {
    const bytes = await getHistoryJsonl(workspace.accessor(), 'C1', '2025-11-03')
    const text = decoder.decode(bytes)
    expect(text.endsWith('\n')).toBe(true)
    const lines = text.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ ts: DEPLOY, user: 'U1' })
  })

  it('sorts messages by ts (numeric ascending)', async () => {
    // Slack answers newest first.
    expect(texts(await getHistoryJsonl(workspace.accessor(), 'C1', '2025-11-03'))).toEqual([
      'the deploy is done at acme',
      'coffee is ready',
    ])
  })

  it('returns empty bytes when no messages', async () => {
    const bytes = await getHistoryJsonl(workspace.accessor(), 'C1', '2025-11-10')
    expect(bytes.length).toBe(0)
  })

  it('paginates when has_more is true', async () => {
    await workspace.firstPage(HISTORY, 1, DAY)
    const bytes = await getHistoryJsonl(workspace.accessor(), 'C1', '2025-11-03')
    const asked = await workspace.run.params('GET', HISTORY)
    expect(asked).toHaveLength(2)
    expect(asked[1]?.cursor).not.toBe('')
    expect(texts(bytes)).toHaveLength(2)
  })

  it('sends correct oldest/latest from date_str (UTC start/end-of-day)', async () => {
    await getHistoryJsonl(workspace.accessor(), 'C1', '2025-11-03')
    const [params] = await workspace.run.params('GET', HISTORY)
    expect(params?.channel).toBe('C1')
    expect(params?.inclusive).toBe('true')
    expect(params?.limit).toBe('200')
    expect(Math.floor(Number(params?.oldest))).toBe(1762128000)
    expect(Math.floor(Number(params?.latest))).toBe(1762214400)
  })

  it('breaks pagination when has_more=true but next_cursor is empty', async () => {
    // Slack's own page, saying there is more but naming no cursor.
    const query = new URLSearchParams(DAY).toString()
    const page = await workspace.run.call<Record<string, unknown>>('GET', `${HISTORY}?${query}`)
    await workspace.run.answerNext('GET', HISTORY, 200, {
      ...page,
      has_more: true,
      response_metadata: { next_cursor: '' },
    } as never)
    await getHistoryJsonl(workspace.accessor(), 'C1', '2025-11-03')
    expect(await workspace.count(HISTORY)).toBe(1)
  })
})

describe('fetchRecentMessages', () => {
  it('fetches one page and sorts ascending by ts', async () => {
    // general's three latest: the plan upload, the second deploy, the files.
    const messages = await fetchRecentMessages(workspace.accessor(), 'C1', 3)
    expect(messages.map((m) => m.ts)).toEqual([
      '1762300860.000001',
      '1762387260.000001',
      '1762560060.000001',
    ])
    expect(await workspace.count(HISTORY)).toBe(1)
  })
})
