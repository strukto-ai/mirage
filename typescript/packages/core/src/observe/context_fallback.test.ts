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
import {
  activeRecords,
  record,
  revisionFor,
  runRecorded,
  runWithRecording,
  runWithRevisions,
} from './context.ts'
import type { OpRecord } from './record.ts'
import type * as asyncContextModule from '../utils/async_context.ts'

// The browser-runtime branch under node's test runner: the real
// FallbackStorage, no task isolation.
vi.mock('../utils/async_context.ts', async (importOriginal) => {
  const real = await importOriginal<typeof asyncContextModule>()
  return {
    ...real,
    asyncContextIsolatesTasks: false,
    createAsyncContext<T>() {
      return new real.FallbackStorage<T>()
    },
  }
})

function gate(): [Promise<void>, () => void] {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  return [held, release]
}

describe('revision pins on the fallback storage', () => {
  it('a pinned read stays pinned while an unpinned frame shadows it', async () => {
    // Pins are mount state handed over per bind, so every live frame's
    // map is searched: the unpinned op's null frame sits on top and
    // contributes nothing, and the pinned mount's map answers from
    // beneath it, where the slot's newest-wins read answered null.
    const pins = new Map([['/s3/report.json', 'r7']])
    const [holdPinned, releasePinned] = gate()
    const [holdNull, releaseNull] = gate()
    let beneathNull: string | null = null
    const pinned = runWithRevisions(pins, async () => {
      await holdPinned
      beneathNull = revisionFor('/s3/report.json')
      releaseNull()
    })
    const unpinned = runWithRevisions(null, async () => {
      releasePinned()
      await holdNull
    })
    await Promise.all([pinned, unpinned])
    expect(beneathNull).toBe('r7')
    expect(revisionFor('/s3/report.json')).toBeNull()
  })
})

describe('recording on the fallback storage', () => {
  it('a record lands after a concurrent recording settles', async () => {
    // The slot's restore dropped every record written after a
    // concurrent line finished: the recorder read as absent and
    // `record` returned silently. The frame stack keeps the live
    // line's recorder until its own settle.
    const [hold, release] = gate()
    const first = runWithRecording(async () => {
      await hold
    })
    const [, records] = await runWithRecording(async () => {
      release()
      await first
      record('read', '/x', 'test', 3, performance.now())
    })
    expect(records).toHaveLength(1)
    expect(records[0]?.path).toBe('/x')
    await first
  })

  it('runRecorded names its own frame, not whichever frame is newest', async () => {
    // The slot answers the newest live frame, so a caller that reads
    // the frame back from inside its own callback can be handed a
    // concurrent read's array — and with it that read's markers.
    // runRecorded takes the array before anything can bind over it.
    const [hold, release] = gate()
    let insideArray: OpRecord[] | null = null
    const { records: mine, done } = runRecorded(async () => {
      record('read', '/mine', 'test', 1, performance.now())
      await hold
      insideArray = activeRecords()
    })
    const [, theirs] = await runWithRecording(async () => {
      release()
      await done
    })
    expect(mine.map((r) => r.path)).toEqual(['/mine'])
    expect(insideArray).toBe(theirs)
    expect(insideArray).not.toBe(mine)
  })

  it('two identity frames cannot overlap, so neither loses its record', async () => {
    // The failure this serialization exists for: `record()` routes by
    // getStore(), which on the fallback answers the newest live frame.
    // Read A emits its record after an await, by which point read B has
    // bound a newer frame and is itself suspended -- so A's record used
    // to land in B's array and A returned no identity at all. No path
    // filter can recover a record that was never appended to A. With
    // the frames serialized, B does not bind until A has settled.
    const [holdA, releaseA] = gate()
    const [holdB, releaseB] = gate()
    const runA = runRecorded(async () => {
      await holdA
      record('read', '/a', 'test', 1, performance.now(), { revision: 'rev-a' })
      return 'A'
    })
    const runB = runRecorded(async () => {
      record('read', '/b', 'test', 1, performance.now(), { revision: 'rev-b' })
      await holdB
      return 'B'
    })
    // A finishes while B is still suspended: unserialized, that is
    // exactly the window where B's frame is the newest live one.
    releaseA()
    expect(await runA.done).toBe('A')
    releaseB()
    expect(await runB.done).toBe('B')
    expect(runA.records.map((r) => [r.path, r.revision])).toEqual([['/a', 'rev-a']])
    expect(runB.records.map((r) => [r.path, r.revision])).toEqual([['/b', 'rev-b']])
  })

  it('two identity frames on the same path each keep their own marker', async () => {
    // Path filtering cannot tell two reads of one path apart, so this
    // pair was the one the previous round left best-effort. Serialized,
    // each read scans a frame only its own op wrote to.
    const [holdFirst, releaseFirst] = gate()
    const [holdSecond, releaseSecond] = gate()
    const first = runRecorded(async () => {
      await holdFirst
      record('read', '/same', 'test', 1, performance.now(), { revision: 'rev-1' })
    })
    const second = runRecorded(async () => {
      record('read', '/same', 'test', 1, performance.now(), { revision: 'rev-2' })
      await holdSecond
    })
    releaseFirst()
    await first.done
    releaseSecond()
    await second.done
    expect(first.records.map((r) => r.revision)).toEqual(['rev-1'])
    expect(second.records.map((r) => r.revision)).toEqual(['rev-2'])
  })

  it('a frame the queue is holding still starts once the one ahead throws', async () => {
    // The queue sequences only; a rejected run must not strand the
    // frames behind it, and its own rejection still reaches its caller.
    const failing = runRecorded(() => Promise.reject(new Error('boom')))
    const next = runRecorded(() => {
      record('read', '/after', 'test', 1, performance.now(), { revision: 'rev-after' })
      return Promise.resolve('ok')
    })
    await expect(failing.done).rejects.toThrow('boom')
    expect(await next.done).toBe('ok')
    expect(next.records.map((r) => r.path)).toEqual(['/after'])
  })

  it('runRecorded keeps the frame records when the run throws', async () => {
    const { records, done } = runRecorded(async () => {
      record('read', '/partial', 'test', 1, performance.now())
      await Promise.resolve()
      throw new Error('boom')
    })
    await expect(done).rejects.toThrow('boom')
    expect(records.map((r) => r.path)).toEqual(['/partial'])
  })
})
