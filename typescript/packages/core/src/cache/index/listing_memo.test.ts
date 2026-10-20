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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileStat, FileType } from '../../types.ts'
import type { Clock } from '../../utils/clock.ts'
import { LookupStatus, type ListResult } from './config.ts'
import { LISTING_TRUST_WINDOW } from './constants.ts'
import { ListingMemo } from './listing_memo.ts'
import { runInCommandScope } from './scope.ts'

const WALL = 2_000_000_000

class Folder {
  reads = 0
  gate: Promise<void> | null = null
  private enter!: () => void
  readonly entered = new Promise<void>((resolve) => (this.enter = resolve))

  constructor(
    readonly entries: string[] = ['/d/a', '/d/b'],
    readonly partial = false,
    readonly expiresAt: number | null = WALL + 60,
  ) {}

  readonly fetch = async (): Promise<[ListResult, number | null]> => {
    this.reads += 1
    this.enter()
    if (this.gate !== null) await this.gate
    if (this.expiresAt === null) return [{ status: LookupStatus.NOT_FOUND }, null]
    if (this.partial) return [{ partialEntries: [...this.entries] }, this.expiresAt]
    return [{ entries: [...this.entries] }, this.expiresAt]
  }
}

function rowBatch(paths: readonly string[]): Promise<Map<string, FileStat>> {
  return Promise.resolve(
    new Map(
      paths.map((path) => [
        path,
        new FileStat({ name: path, type: FileType.FILE, extra: { key: 'original' } }),
      ]),
    ),
  )
}

function gate(): { open: () => void; opened: Promise<void> } {
  let open!: () => void
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { open, opened }
}

function held(memo: ListingMemo): string[] {
  const reads = (memo as unknown as { reads: Map<string, unknown> }).reads
  return [...reads.keys()].map((key) => key.slice(key.indexOf(':') + 1)).sort()
}

describe('ListingMemo', () => {
  let elapsed: number
  let memo: ListingMemo
  let prefix: string
  const clock: Clock = { now: () => WALL + elapsed, monotonic: () => 1_000 + elapsed }

  beforeEach(() => {
    elapsed = 0
    vi.spyOn(performance, 'now').mockImplementation(() => 1_000_000 + elapsed * 1000)
    prefix = `test:${Math.random().toString(36).slice(2)}:`
    memo = new ListingMemo(prefix, clock)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([false, true])(
    'bounds row batches and isolates row copies (partial: %s)',
    async (partial) => {
      const paths = Array.from({ length: 1000 }, (_, n) => `/d/${String(n)}`)
      const fetch = vi.fn(rowBatch)
      expect(await memo.row('/d/0', fetch)).toBeNull()
      await runInCommandScope(async () => {
        await memo.read('/d', new Folder(paths, partial).fetch)
        for (const path of paths) {
          const row = await memo.row(path, fetch)
          expect(row?.name).toBe(path)
          if (row === null) throw new Error('missing row')
          row.extra.key = 'changed'
        }
        expect((await memo.row('/d/0', fetch))?.extra.key).toBe('original')
      })
      expect(fetch).toHaveBeenCalledTimes(4)
      expect(Math.max(...fetch.mock.calls.map(([batch]) => batch.length))).toBeLessThanOrEqual(256)
      expect(await memo.row('/d/0', fetch)).toBeNull()
    },
  )

  it.each([LISTING_TRUST_WINDOW / 2, LISTING_TRUST_WINDOW * 2])(
    'expires rows at the listing expiry or trust window (%s)',
    async (expiry) => {
      await runInCommandScope(async () => {
        await memo.read('/d', new Folder(undefined, false, WALL + expiry).fetch)
        expect(await memo.row('/d/a', rowBatch)).not.toBeNull()
        elapsed = Math.min(expiry, LISTING_TRUST_WINDOW)
        expect(await memo.row('/d/a', rowBatch)).toBeNull()
      })
    },
  )

  it('does not keep a row batch that overlaps a write', async () => {
    const fetch = vi.fn((paths: readonly string[]) => {
      memo.rowWrote('/d/a')
      return rowBatch(paths)
    })
    await runInCommandScope(async () => {
      await memo.read('/d', new Folder().fetch)
      await memo.row('/d/a', fetch)
      await memo.row('/d/b', fetch)
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not fetch rows a batch did not find again', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Map<string, FileStat>()))
    await runInCommandScope(async () => {
      await memo.read('/d', new Folder().fetch)
      for (const path of ['/d/a', '/d/b', '/d/a']) {
        expect(await memo.row(path, fetch)).toBeNull()
      }
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('refetches a written row alone', async () => {
    const fetch = vi.fn(rowBatch)
    await runInCommandScope(async () => {
      await memo.read('/d', new Folder().fetch)
      await memo.row('/d/a', fetch)
      memo.rowWrote('/d/a')
      expect(await memo.row('/d/b', fetch)).not.toBeNull()
      expect(await memo.row('/d/a', fetch)).not.toBeNull()
    })
    expect(fetch.mock.calls.map(([batch]) => batch)).toEqual([['/d/a', '/d/b'], ['/d/a']])
  })

  it('reads a listing once per command', async () => {
    const folder = new Folder()
    const within = await runInCommandScope(async () => {
      const seen = []
      for (let n = 0; n < 10; n++) seen.push(await memo.read('/d', folder.fetch))
      return seen
    })
    expect(folder.reads).toBe(1)
    const outside = []
    for (let n = 0; n < 10; n++) outside.push(await memo.read('/d', folder.fetch))
    expect(folder.reads).toBe(11)
    expect(within).toEqual(outside)
    expect(within[0]?.entries).toEqual(['/d/a', '/d/b'])
  })

  it('reads each command its own listing', async () => {
    const folder = new Folder()
    for (let n = 0; n < 2; n++) {
      await runInCommandScope(async () => {
        await memo.read('/d', folder.fetch)
        await memo.read('/d', folder.fetch)
      })
    }
    expect(folder.reads).toBe(2)
    await runInCommandScope(async () => {
      await memo.read('/d', folder.fetch)
      await runInCommandScope(() => memo.read('/d', folder.fetch))
      await memo.read('/d', folder.fetch)
    })
    expect(folder.reads).toBe(4)
  })

  it('reads a listing without an expiry each time', async () => {
    const folder = new Folder(undefined, false, null)
    await runInCommandScope(async () => {
      for (let n = 0; n < 2; n++) {
        expect((await memo.read('/d', folder.fetch)).status).toBe(LookupStatus.NOT_FOUND)
      }
    })
    expect(folder.reads).toBe(2)
  })

  it('drops the listing read once a write on the prefix finishes', async () => {
    const folder = new Folder()
    const other = new ListingMemo(`${prefix}other:`, clock)
    await runInCommandScope(async () => {
      await memo.read('/d', folder.fetch)
      other.wrote()
      await memo.read('/d', folder.fetch)
      expect(folder.reads).toBe(1)
      new ListingMemo(prefix, clock).wrote()
      await memo.read('/d', folder.fetch)
    })
    expect(folder.reads).toBe(2)
  })

  it('keeps a live memo its count when a peer on the prefix closes', async () => {
    const folder = new Folder()
    const peer = new ListingMemo(prefix, clock)
    peer.wrote()
    await runInCommandScope(async () => {
      await memo.read('/d', folder.fetch)
      peer.close()
      peer.close()
      await memo.read('/d', folder.fetch)
      expect(folder.reads).toBe(1)
      new ListingMemo(prefix, clock).wrote()
      await memo.read('/d', folder.fetch)
    })
    expect(folder.reads).toBe(2)
  })

  it('counts a write that finishes after its memo closed', async () => {
    const shared = `${prefix}shared:`
    const closed = new ListingMemo(shared, clock)
    closed.close()
    const fresh = new ListingMemo(shared, clock)
    const folder = new Folder()
    await runInCommandScope(async () => {
      await fresh.read('/d', folder.fetch)
      closed.wrote()
      await fresh.read('/d', folder.fetch)
    })
    expect(folder.reads).toBe(2)
  })

  it('counts a write when it finishes, resolved or rejected', async () => {
    const folder = new Folder()
    const release = gate()
    await runInCommandScope(async () => {
      const writing = memo.writing(() => release.opened)
      await memo.read('/d', folder.fetch)
      await memo.read('/d', folder.fetch)
      expect(folder.reads).toBe(1)
      release.open()
      await writing
      await memo.read('/d', folder.fetch)
      expect(folder.reads).toBe(2)
      await expect(memo.writing(() => Promise.reject(new Error('refused')))).rejects.toThrow(
        'refused',
      )
      await memo.read('/d', folder.fetch)
    })
    expect(folder.reads).toBe(3)
  })

  it('does not keep a read that overlaps a finished write', async () => {
    const folder = new Folder()
    const release = gate()
    folder.gate = release.opened
    await runInCommandScope(async () => {
      const reading = memo.read('/d', folder.fetch)
      await folder.entered
      memo.wrote()
      release.open()
      await reading
      await memo.read('/d', folder.fetch)
    })
    expect(folder.reads).toBe(2)
  })

  it('trusts a listing for under the window', async () => {
    const folder = new Folder()
    await runInCommandScope(async () => {
      await memo.read('/d', folder.fetch)
      elapsed = LISTING_TRUST_WINDOW * 0.9
      await memo.read('/d', folder.fetch)
      expect(folder.reads).toBe(1)
      elapsed = LISTING_TRUST_WINDOW
      await memo.read('/d', folder.fetch)
    })
    expect(folder.reads).toBe(2)
  })

  it('never serves a listing past its expiry', async () => {
    const folder = new Folder(undefined, false, WALL + LISTING_TRUST_WINDOW / 4)
    await runInCommandScope(async () => {
      await memo.read('/d', folder.fetch)
      elapsed = LISTING_TRUST_WINDOW / 4
      await memo.read('/d', folder.fetch)
    })
    expect(folder.reads).toBe(2)
  })

  it.each([false, true])('lets no caller change a later answer (partial=%s)', async (partial) => {
    const folder = new Folder(undefined, partial)
    const field = partial ? 'partialEntries' : 'entries'
    const after = await runInCommandScope(async () => {
      ;(await memo.read('/d', folder.fetch))[field]?.push('/d/x')
      ;(await memo.read('/d', folder.fetch))[field]?.splice(0)
      return memo.read('/d', folder.fetch)
    })
    expect(folder.reads).toBe(1)
    expect(after[field]).toEqual(['/d/a', '/d/b'])
  })

  it('drops on a fill the listings no command can be served', async () => {
    const live = new Folder()
    await runInCommandScope(async () => {
      await runInCommandScope(() => memo.read('/aged', new Folder().fetch))
      elapsed = LISTING_TRUST_WINDOW * 0.6
      await memo.read('/live', live.fetch)
      elapsed = LISTING_TRUST_WINDOW * 1.2
      await runInCommandScope(() => memo.read('/next', new Folder().fetch))
      expect(held(memo)).toEqual(['/live', '/next'])
      await memo.read('/live', live.fetch)
    })
    expect(live.reads).toBe(1)
  })

  it('drops on a fill the listings a write or expiry ended', async () => {
    await runInCommandScope(async () => {
      await memo.read('/written', new Folder().fetch)
      memo.wrote()
      await memo.read('/expiring', new Folder(undefined, false, WALL + 0.1).fetch)
      elapsed = 0.1
      await memo.read('/next', new Folder().fetch)
    })
    expect(held(memo)).toEqual(['/next'])
  })
})
