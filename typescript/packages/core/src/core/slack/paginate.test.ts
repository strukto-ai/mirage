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
import { LISTING, SlackWorkspace, USERS } from '../../../tests/core/slack/workspace.ts'
import { cursorPages } from './paginate.ts'

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

describe('cursorPages', () => {
  it('refuses a repeated cursor before fetching a third page', async () => {
    // A listing that answers the cursor it was asked with, twice running.
    const loop = { ok: true, members: [], response_metadata: { next_cursor: 'loop' } }
    await workspace.run.answerNext('GET', USERS, 200, loop, 2)
    const pages = cursorPages(workspace.accessor().transport, 'users.list', {}, 'members')
    await pages.next()
    await pages.next()
    await expect(pages.next()).rejects.toThrow('pagination did not advance')
    expect(await workspace.count(USERS)).toBe(2)
  })

  it('walks until empty cursor', async () => {
    const result: string[][] = []
    for await (const page of cursorPages<{ id: string }>(
      workspace.accessor().transport,
      'conversations.list',
      { types: TYPES, limit: '1' },
      'channels',
    )) {
      result.push(page.map((c) => c.id))
    }
    expect(result).toEqual([['C1'], ['C2']])
    const [first, second] = await workspace.run.params('GET', LISTING)
    expect(first).toEqual({ types: TYPES, limit: '1' })
    expect(second).toEqual({ types: TYPES, limit: '1', cursor: second?.cursor })
    expect(second?.cursor).not.toBe('')
  })

  it('terminates without further calls after caller breaks', async () => {
    for await (const page of cursorPages<{ id: string }>(
      workspace.accessor().transport,
      'conversations.list',
      { types: TYPES, limit: '1' },
      'channels',
    )) {
      expect(page.map((c) => c.id)).toEqual(['C1'])
      break
    }
    expect(await workspace.count(LISTING)).toBe(1)
  })

  it('yields an empty page when items key absent', async () => {
    await workspace.run.answerNext('GET', USERS, 200, {
      ok: true,
      response_metadata: { next_cursor: '' },
    })
    const result: unknown[][] = []
    for await (const page of cursorPages(
      workspace.accessor().transport,
      'users.list',
      { limit: '10' },
      'members',
    )) {
      result.push(page)
    }
    expect(result).toEqual([[]])
  })
})
