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
import { ObjectStorage } from '../../tests/object_storage.ts'
import { PAGE_BYTES, PageLog, type PageLogOptions } from './log.ts'

// Rows of six pages and budgets of a few pages, so a short run spills, reuses
// rows, compacts and reads past its cache many times over.
const SMALL: PageLogOptions = {
  columnPages: 2,
  columns: 3,
  cacheBytes: 8 * PAGE_BYTES,
  spillBytes: 10 * PAGE_BYTES,
  spareRows: 2,
  compactBytes: 8 * PAGE_BYTES,
  compactStepBytes: 12 * PAGE_BYTES,
}

function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function page(stamp: number): Uint8Array {
  const data = new Uint8Array(PAGE_BYTES)
  new DataView(data.buffer).setUint32(0, stamp, true)
  data.fill(stamp % 251, 4)
  return data
}

function stampOf(log: PageLog, at: number): number | null {
  const data = log.read(at)
  return data === null ? null : new DataView(data.buffer, data.byteOffset).getUint32(0, true)
}

function stamps(log: PageLog): (number | null)[] {
  return Array.from({ length: log.size }, (_, at) => stampOf(log, at))
}

describe('the page log of a paged database', () => {
  it('answers what was committed after any run of writes, cuts, commits and reloads', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rand = random(seed)
      const pick = (n: number): number => Math.floor(rand() * n)
      const storage = new ObjectStorage()
      let log = new PageLog(storage, SMALL)
      let committed: number[] = []
      let current: number[] = []
      let stamp = 0
      for (let op = 0; op < 1500; op++) {
        const r = rand()
        if (r < 0.62) {
          const end = current.length + (rand() < 0.1 ? pick(4) : 0)
          const at = current.length === 0 || rand() < 0.3 ? end : pick(current.length)
          log.write(at, page(++stamp))
          while (current.length < at) current.push(0)
          current[at] = stamp
        } else if (r < 0.66) {
          const size = pick(current.length + 1)
          log.truncate(size)
          current.length = size
        } else if (r < 0.8) {
          if (current.length > 0) {
            const at = pick(current.length)
            expect(stampOf(log, at), `seed ${String(seed)} op ${String(op)}`).toBe(current[at])
          }
        } else if (r < 0.94) {
          log.flush()
          committed = [...current]
        } else if (r < 0.97) {
          log.flush()
          committed = [...current]
          log = new PageLog(storage, SMALL)
          expect(stamps(log), `seed ${String(seed)} reload at ${String(op)}`).toEqual(committed)
        } else {
          log = new PageLog(storage, SMALL)
          current = [...committed]
          expect(stamps(log), `seed ${String(seed)} stop at ${String(op)}`).toEqual(committed)
        }
      }
      log.flush()
      expect(stamps(new PageLog(storage, SMALL)), `seed ${String(seed)} end`).toEqual(current)
    }
  })

  it('answers every page but the abandoned ones after any run with pages abandoned', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rand = random(seed)
      const pick = (n: number): number => Math.floor(rand() * n)
      const storage = new ObjectStorage()
      let log = new PageLog(storage, SMALL)
      let committed: number[] = []
      let current: number[] = []
      let gone = new Set<number>()
      let goneCommitted = new Set<number>()
      let stamp = 0
      const kept = (now: PageLog, want: readonly number[], lost: ReadonlySet<number>): boolean =>
        want.every((value, at) => lost.has(at) || stampOf(now, at) === value)
      for (let op = 0; op < 1500; op++) {
        const r = rand()
        if (r < 0.56) {
          const end = current.length + (rand() < 0.1 ? pick(4) : 0)
          const at = current.length === 0 || rand() < 0.3 ? end : pick(current.length)
          log.write(at, page(++stamp))
          while (current.length < at) current.push(0)
          current[at] = stamp
          gone.delete(at)
        } else if (r < 0.64) {
          const from = pick(current.length + 1)
          const pages = Array.from({ length: pick(9) }, (_, i) => from + i)
          log.abandon(pages)
          for (const at of pages) if (at < current.length) gone.add(at)
        } else if (r < 0.68) {
          const size = pick(current.length + 1)
          log.truncate(size)
          current.length = size
          gone = new Set([...gone].filter((at) => at < size))
        } else if (r < 0.94) {
          log.flush()
          committed = [...current]
          goneCommitted = new Set(gone)
        } else if (r < 0.97) {
          log.flush()
          committed = [...current]
          goneCommitted = new Set(gone)
          log = new PageLog(storage, SMALL)
        } else {
          log = new PageLog(storage, SMALL)
          current = [...committed]
          gone = new Set(goneCommitted)
        }
        expect(log.size, `seed ${String(seed)} op ${String(op)}`).toBe(current.length)
        expect(kept(log, current, gone), `seed ${String(seed)} op ${String(op)}`).toBe(true)
      }
    }
  })

  it('stores an abandoned page no more, until it is written again', () => {
    const storage = new ObjectStorage()
    const log = new PageLog(storage, SMALL)
    for (let at = 0; at < 24; at++) log.write(at, page(at + 1))
    log.flush()
    const full = storage.bytes()
    log.abandon(Array.from({ length: 18 }, (_, i) => i + 6))
    log.flush()
    expect(storage.bytes()).toBeLessThan(full)
    log.write(7, page(99))
    log.flush()
    const again = new PageLog(storage.restarted(), SMALL)
    expect(again.size).toBe(24)
    expect(stamps(again).slice(0, 6)).toEqual([1, 2, 3, 4, 5, 6])
    expect(stampOf(again, 7)).toBe(99)
    // An abandoned page answers nothing, or what a commit once held there.
    expect([null, 9]).toContain(stampOf(again, 8))
  })

  it('moves no page in the commit that abandons some, so it wants no room for that', () => {
    const storage = new ObjectStorage()
    const log = new PageLog(storage, SMALL)
    for (let at = 0; at < 36; at++) log.write(at, page(at + 1))
    log.flush()
    // Four pages in six are abandoned, which leaves every row sparse and
    // the log due to move the pages still in them.
    const left = Array.from({ length: 36 }, (_, at) => at).filter((at) => at % 6 < 2)
    log.abandon(Array.from({ length: 36 }, (_, at) => at).filter((at) => at % 6 >= 2))
    log.write(0, page(100))
    storage.room(4 * PAGE_BYTES)
    log.flush()
    const sparse = log.deadBytes
    storage.room(1 << 20)
    log.write(1, page(101))
    log.flush()
    expect(log.deadBytes).toBeLessThan(sparse)
    const again = new PageLog(storage.restarted(), SMALL)
    expect(left.map((at) => stampOf(again, at))).toEqual(
      left.map((at) => (at === 0 ? 100 : at === 1 ? 101 : at + 1)),
    )
  })

  it('writes a commit as rows of many pages', () => {
    const storage = new ObjectStorage()
    const log = new PageLog(storage)
    for (let at = 0; at < 1000; at++) log.write(at, page(at + 1))
    expect(log.flush()).toBe(3)
    expect(storage.rowsWritten).toBe(3)
    expect(stamps(new PageLog(storage))).toEqual(Array.from({ length: 1000 }, (_, at) => at + 1))
  })

  it('keeps the last commit when the storage fails in the middle of the next', () => {
    const storage = new ObjectStorage()
    const log = new PageLog(storage, SMALL)
    for (let at = 0; at < 20; at++) log.write(at, page(at + 1))
    log.flush()
    for (let at = 0; at < 20; at++) log.write(at, page(at + 101))
    storage.writesLeft = 1
    expect(() => log.flush()).toThrow('the storage refused a write')
    expect(() => {
      log.write(0, page(1))
    }).toThrow('the storage refused a write')
    expect(() => log.read(0)).toThrow('the storage refused a write')
    storage.writesLeft = null
    expect(stamps(new PageLog(storage, SMALL))).toEqual(
      Array.from({ length: 20 }, (_, at) => at + 1),
    )
  })

  it('answers nothing more once the storage fails a row written ahead of its commit', () => {
    const storage = new ObjectStorage()
    const log = new PageLog(storage, SMALL)
    log.write(0, page(1))
    log.flush()
    storage.writesLeft = 0
    expect(() => {
      for (let at = 0; at < 20; at++) log.write(at, page(at + 101))
    }).toThrow('the storage refused a write')
    expect(() => log.read(0)).toThrow('the storage refused a write')
    expect(() => log.flush()).toThrow('the storage refused a write')
    storage.writesLeft = null
    expect(stamps(new PageLog(storage, SMALL))).toEqual([1])
  })

  it('writes zeros between the end and a page past it, whatever was there before a cut', () => {
    const storage = new ObjectStorage()
    const log = new PageLog(storage, SMALL)
    for (let at = 0; at < 20; at++) log.write(at, page(at + 1))
    log.flush()
    log.truncate(5)
    log.write(11, page(99))
    expect(stamps(log)).toEqual([1, 2, 3, 4, 5, 0, 0, 0, 0, 0, 0, 99])
    log.flush()
    expect(stamps(new PageLog(storage, SMALL))).toEqual([1, 2, 3, 4, 5, 0, 0, 0, 0, 0, 0, 99])
  })

  it('keeps a commit whose last row holds no page while later pages are written ahead', () => {
    const storage = new ObjectStorage()
    const log = new PageLog(storage, SMALL)
    for (let at = 0; at < 20; at++) log.write(at, page(at + 1))
    log.flush()
    log.truncate(5)
    log.flush()
    for (let at = 5; at < 20; at++) log.write(at, page(at + 101))
    expect(stamps(new PageLog(storage, SMALL))).toEqual([1, 2, 3, 4, 5])
  })

  it('refuses a table whose rows are not its own', () => {
    const storage = new ObjectStorage()
    new PageLog(storage, SMALL).write(0, page(1))
    storage.sql.exec('INSERT INTO mirage_page_log (id, head) VALUES (?, ?)', 9, new ArrayBuffer(4))
    expect(() => new PageLog(storage, SMALL)).toThrow('mirage_page_log row 9 is not a page log row')
  })
})
