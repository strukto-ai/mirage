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
import { SlackWorkspace, USERS } from '../../../tests/core/slack/workspace.ts'
import { listUsersStream } from './users.ts'

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

describe('listUsersStream', () => {
  it('filters bots/deleted/USLACKBOT per page before yielding', async () => {
    const collected: (string | undefined)[][] = []
    for await (const page of listUsersStream(workspace.accessor())) {
      collected.push(page.map((u) => u.id))
    }
    expect(collected).toEqual([['U1', 'U2']])
  })

  it('walks all pages', async () => {
    await workspace.firstPage(USERS, 1)
    const ids: (string | undefined)[] = []
    for await (const page of listUsersStream(workspace.accessor())) {
      for (const u of page) ids.push(u.id)
    }
    expect(ids).toEqual(['U1', 'U2'])
    expect(await workspace.count(USERS)).toBe(2)
  })
})
