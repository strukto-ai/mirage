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
import { listChannels, listDms } from './channels.ts'

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

describe('listChannels', () => {
  it('paginates conversations.list using response_metadata.next_cursor', async () => {
    await workspace.firstPage(LISTING, 1, { types: TYPES })
    const out = await listChannels(workspace.accessor())
    expect(out.map((c) => c.id)).toEqual(['C1', 'C2'])
    const [first, second] = await workspace.run.params('GET', LISTING)
    expect(first).toMatchObject({ types: TYPES, limit: '200', exclude_archived: 'true' })
    expect(second?.cursor).not.toBe('')
  })

  it('uses custom types and limit', async () => {
    // random is private, so the public channels alone are general.
    const out = await listChannels(workspace.accessor(), { types: 'public_channel', limit: 50 })
    expect(out.map((c) => c.id)).toEqual(['C1'])
    expect((await workspace.run.params('GET', LISTING))[0]).toMatchObject({
      types: 'public_channel',
      limit: '50',
    })
  })

  it('returns empty array when no channels', async () => {
    // The workspace holds no group DM.
    expect(await listChannels(workspace.accessor(), { types: 'mpim' })).toEqual([])
  })
})

describe('listDms', () => {
  it('calls conversations.list with types=im,mpim', async () => {
    const out = await listDms(workspace.accessor())
    expect((await workspace.run.params('GET', LISTING))[0]).toMatchObject({
      types: 'im,mpim',
      limit: '200',
    })
    expect(out.map((c) => [c.id, (c as { user?: string }).user])).toEqual([['D1', 'U1']])
  })
})
