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
import { EMOJI, SlackWorkspace } from '../../../tests/core/slack/workspace.ts'
import { listEmoji } from './emoji.ts'

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

describe('listEmoji', () => {
  it('GETs emoji.list and returns the mapping', async () => {
    // The workspace's custom emoji: one image, one alias.
    expect(await listEmoji(workspace.accessor())).toEqual({
      shipit: 'https://emoji.example/shipit.png',
      partyparrot: 'alias:parrot',
    })
    expect(await workspace.count(EMOJI)).toBe(1)
  })

  it('tolerates a missing emoji key', async () => {
    await workspace.run.answerNext('GET', EMOJI, 200, { ok: true })
    expect(await listEmoji(workspace.accessor())).toEqual({})
  })
})
