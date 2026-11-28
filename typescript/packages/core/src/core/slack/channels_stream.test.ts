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
import { LISTING, SlackWorkspace } from '../../../tests/core/slack/workspace.ts'
import { listChannels, listChannelsStream } from './channels.ts'

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

const TYPES = 'public_channel,private_channel'

describe('listChannelsStream', () => {
  it('yields one page per round-trip', async () => {
    await workspace.firstPage(LISTING, 1, { types: TYPES })
    const collected: string[][] = []
    for await (const page of listChannelsStream(workspace.accessor())) {
      collected.push(page.map((c) => c.id))
    }
    expect(collected).toEqual([['C1'], ['C2']])
    const asked = await workspace.run.params('GET', LISTING)
    expect(asked).toHaveLength(2)
    expect(asked[0]).toMatchObject({ types: TYPES, limit: '200', exclude_archived: 'true' })
  })

  it('caller can break early without further calls', async () => {
    await workspace.firstPage(LISTING, 1, { types: TYPES })
    for await (const _page of listChannelsStream(workspace.accessor())) {
      void _page
      break
    }
    expect(await workspace.count(LISTING)).toBe(1)
  })
})

describe('listChannels (eager wrapper)', () => {
  it('flattens all pages', async () => {
    await workspace.firstPage(LISTING, 1, { types: TYPES })
    const out = await listChannels(workspace.accessor())
    expect(out.map((c) => c.id)).toEqual(['C1', 'C2'])
  })
})
