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
import { REACT, REACTIONS, SlackWorkspace } from '../../../tests/core/slack/workspace.ts'
import { addReaction, getReactions } from './react.ts'

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

// "lunch at noon" in general, which ana reacted to with a rocket.
const LUNCH = '1762214460.000001'

describe('addReaction', () => {
  it('POSTs to reactions.add with channel, timestamp, name', async () => {
    const accessor = workspace.accessor()
    const out = await addReaction(accessor, 'C1', LUNCH, 'thumbsup')
    expect(await workspace.run.bodies('POST', REACT)).toEqual([
      { channel: 'C1', timestamp: LUNCH, name: 'thumbsup' },
    ])
    expect(await workspace.run.params('POST', REACT)).toEqual([{}])
    expect(out).toMatchObject({ ok: true })
    const message = (await getReactions(accessor, 'C1', LUNCH)) as { reactions: { name: string }[] }
    expect(message.reactions.map((r) => r.name)).toEqual(['rocket', 'thumbsup'])
  })
})

describe('getReactions', () => {
  it('GETs reactions.get and returns the message item', async () => {
    const message = await getReactions(workspace.accessor(), 'C1', LUNCH)
    expect(await workspace.run.params('GET', REACTIONS)).toEqual([
      { channel: 'C1', timestamp: LUNCH },
    ])
    expect(message).toMatchObject({
      ts: LUNCH,
      reactions: [{ name: 'rocket', users: ['U1'], count: 1 }],
    })
  })
})
