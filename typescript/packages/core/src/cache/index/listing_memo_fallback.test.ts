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

import type * as AsyncContext from '../../utils/async_context.ts'
import { describe, expect, it, vi } from 'vitest'
import type { ListResult } from './config.ts'
import { SystemClock } from '../../utils/clock.ts'
import { ListingMemo } from './listing_memo.ts'
import { runInCommandScope } from './scope.ts'

vi.mock('../../utils/async_context.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof AsyncContext>()
  return {
    ...actual,
    asyncContextIsolatesTasks: false,
    createAsyncContext: () => new actual.FallbackStorage(),
  }
})

function gate(): { open: () => void; opened: Promise<void> } {
  let open!: () => void
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { open, opened }
}

function counted(): { reads: () => number; fetch: () => Promise<[ListResult, number]> } {
  let reads = 0
  return {
    reads: () => reads,
    fetch: () => {
      reads += 1
      return Promise.resolve([{ entries: ['/d/a', '/d/b'] }, Date.now() / 1000 + 60])
    },
  }
}

describe('ListingMemo on the fallback storage', () => {
  it('reads every time while two commands are live', async () => {
    const memo = new ListingMemo(`test:${Math.random().toString(36).slice(2)}:`, new SystemClock())
    const folder = counted()
    const live = gate()
    const entered = gate()
    const other = runInCommandScope(async () => {
      entered.open()
      await live.opened
    })
    await entered.opened
    await runInCommandScope(async () => {
      await memo.read('/d', folder.fetch)
      await memo.read('/d', folder.fetch)
    })
    live.open()
    await other
    expect(folder.reads()).toBe(2)
    await runInCommandScope(async () => {
      await memo.read('/d', folder.fetch)
      await memo.read('/d', folder.fetch)
    })
    expect(folder.reads()).toBe(3)
  })

  it('does not keep a read that a second command overlapped', async () => {
    const memo = new ListingMemo(`test:${Math.random().toString(36).slice(2)}:`, new SystemClock())
    const reading = gate()
    const release = gate()
    let reads = 0
    const fetch = async (): Promise<[ListResult, number]> => {
      reads += 1
      if (reads === 1) {
        reading.open()
        await release.opened
      }
      return [{ entries: ['/d/a', '/d/b'] }, Date.now() / 1000 + 60]
    }
    const live = gate()
    await runInCommandScope(async () => {
      const read = memo.read('/d', fetch)
      await reading.opened
      const other = runInCommandScope(() => live.opened)
      release.open()
      await read
      live.open()
      await other
      await memo.read('/d', fetch)
    })
    expect(reads).toBe(2)
  })
})
