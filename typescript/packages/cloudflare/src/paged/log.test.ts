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
          const at = current.length === 0 || rand() < 0.3 ? current.length : pick(current.length)
          log.write(at, page(++stamp))
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
    storage.writesLeft = null
    expect(stamps(new PageLog(storage, SMALL))).toEqual(
      Array.from({ length: 20 }, (_, at) => at + 1),
    )
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
