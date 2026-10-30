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

import { describe, expect, it, vi } from 'vitest'
import type * as asyncContextModule from '../utils/async_context.ts'
import { Policies } from '../policy/policies.ts'
import { liveEgress, runWithEgress, withEgress } from './gateway.ts'
import type { NetworkRule } from './network.ts'

// The browser-runtime branch under node's test runner: the real
// FallbackStorage, no task isolation.
vi.mock('../utils/async_context.ts', async (importOriginal) => {
  const real = await importOriginal<typeof asyncContextModule>()
  return {
    ...real,
    asyncContextIsolatesTasks: false,
    createAsyncContext: <T>() => new real.FallbackStorage<T>(),
  }
})

describe('liveEgress without task isolation', () => {
  it("answers every live line's egress, since it cannot tell whose connection it is", async () => {
    const first = new Policies()
    const second = new Policies()
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const waiting = runWithEgress(null, first, async () => {
      await held
      return liveEgress().map((egress) => egress.policies)
    })
    const overlapping = await runWithEgress(null, second, () =>
      Promise.resolve(liveEgress().map((egress) => egress.policies)),
    )
    expect(overlapping).toEqual([first, second])
    release()
    expect(await waiting).toEqual([first])
    expect(liveEgress()).toEqual([])
  })
})

describe('withEgress without task isolation', () => {
  it('keeps the egress it is handed, not the newest frame', async () => {
    const mine = new Policies()
    const theirs = new Policies()
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const seen: (Policies | null)[] = []
    async function* source(): AsyncGenerator<Uint8Array> {
      await Promise.resolve()
      seen.push(liveEgress().at(-1)?.policies ?? null)
      yield new Uint8Array([1])
    }
    const stream = await runWithEgress({ lets: () => true } as unknown as NetworkRule, mine, () => {
      const owner = liveEgress().at(-1) ?? null
      return Promise.resolve(withEgress(source(), owner))
    })
    const other = runWithEgress(null, theirs, () => held)
    for await (const chunk of stream) expect(chunk).toEqual(new Uint8Array([1]))
    release()
    await other
    expect(seen).toEqual([mine])
  })
})
