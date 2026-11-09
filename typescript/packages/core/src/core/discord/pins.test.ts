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
import type { DiscordTransport } from './client.ts'
import { listPins } from './pins.ts'

describe('listPins', () => {
  it('pages back from the oldest pin seen', async () => {
    const seen: (string | undefined)[] = []
    const transport: DiscordTransport = {
      call(_method, _endpoint, params) {
        const before = params?.before as string | undefined
        seen.push(before)
        return Promise.resolve(
          before === undefined
            ? { items: [{ pinned_at: 't2' }], has_more: true }
            : { items: [{ pinned_at: 't1' }], has_more: false },
        )
      },
    }

    const pins = await listPins(new DiscordAccessor(transport), 'c1')

    expect(pins.map((pin) => pin.pinned_at)).toEqual(['t2', 't1'])
    expect(seen).toEqual([undefined, 't2'])
  })
})
