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
import { PINS, PINS_ADD, PINS_REMOVE, SlackWorkspace } from '../../../tests/core/slack/workspace.ts'
import { listPins, pinMessage, unpinMessage } from './pins.ts'

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

describe('pins', () => {
  it('pinMessage POSTs pins.add', async () => {
    const accessor = workspace.accessor()
    await pinMessage(accessor, 'C1', LUNCH)
    expect(await workspace.run.bodies('POST', PINS_ADD)).toEqual([
      { channel: 'C1', timestamp: LUNCH },
    ])
    const pinned = (await listPins(accessor, 'C1')) as { message: { ts: string } }[]
    expect(pinned.map((item) => item.message.ts)).toEqual([LUNCH])
  })

  it('unpinMessage POSTs pins.remove', async () => {
    await workspace.pin('C1', LUNCH)
    const accessor = workspace.accessor()
    await unpinMessage(accessor, 'C1', LUNCH)
    expect(await workspace.run.bodies('POST', PINS_REMOVE)).toEqual([
      { channel: 'C1', timestamp: LUNCH },
    ])
    expect(await listPins(accessor, 'C1')).toEqual([])
  })

  it('listPins returns items and tolerates a missing key', async () => {
    await workspace.pin('C1', LUNCH)
    const accessor = workspace.accessor()
    const items = (await listPins(accessor, 'C1')) as { type: string; message: { text: string } }[]
    expect(items.map((i) => [i.type, i.message.text])).toEqual([['message', 'lunch at noon']])
    expect(await workspace.run.params('GET', PINS)).toEqual([{ channel: 'C1' }])
    await workspace.run.answerNext('GET', PINS, 200, { ok: true })
    expect(await listPins(accessor, 'C1')).toEqual([])
  })
})
