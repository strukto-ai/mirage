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
import { InFlight, rpcMessages } from './inflight.ts'

describe('InFlight', () => {
  it('cancels a held call once', () => {
    const inflight = new InFlight()
    const stopped: string[] = []
    const key = InFlight.key('ws', 's', 7)
    inflight.add(key, () => stopped.push('stopped'))
    expect(inflight.cancel(InFlight.key('ws', 'other', 7))).toBe(false)
    expect(inflight.cancel(key)).toBe(true)
    expect(inflight.cancel(key)).toBe(false)
    expect(stopped).toEqual(['stopped'])
  })

  it('does not cancel a discarded call', () => {
    const inflight = new InFlight()
    const key = InFlight.key('ws', 's', 'a')
    const cancel = (): void => undefined
    inflight.add(key, cancel)
    inflight.discard(key, cancel)
    expect(inflight.cancel(key)).toBe(false)
  })

  it('keeps two calls that share an id apart', () => {
    const inflight = new InFlight()
    const stopped: string[] = []
    const key = InFlight.key('ws', 's', 1)
    const first = (): void => void stopped.push('first')
    const second = (): void => void stopped.push('second')
    const third = (): void => void stopped.push('third')
    inflight.add(key, first)
    inflight.add(key, second)
    inflight.add(key, third)
    inflight.discard(key, first)
    expect(inflight.cancel(key)).toBe(true)
    expect(stopped).toEqual(['second', 'third'])
  })

  it('reads one message or a batch', () => {
    expect(rpcMessages({ id: 1 })).toEqual([{ id: 1 }])
    expect(rpcMessages([{ id: 1 }, 3, { id: 2 }])).toEqual([{ id: 1 }, { id: 2 }])
    expect(rpcMessages(undefined)).toEqual([])
  })
})
