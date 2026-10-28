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

import { CapacityState, PathSpec } from '../types.ts'
import { StorageUsage, charge, storageUsage } from './capacity.ts'
import { VFSConfigError } from './errors.ts'

const F = PathSpec.fromStrPath('/data/f')

describe('StorageUsage', () => {
  it('passes reaching the limit exactly and refuses one more byte', () => {
    const usage = new StorageUsage(10, 6)
    usage.admit(F, 4)
    expect(() => {
      usage.admit(F, 5)
    }).toThrow(expect.objectContaining({ code: 'EDQUOT' }) as Error)
  })

  it('passes growth of zero or less over the cap', () => {
    const usage = new StorageUsage(10, 50)
    usage.admit(F, 0)
    usage.admit(F, -3)
  })

  it('admits only empty files under a zero cap', () => {
    const usage = new StorageUsage(0, 0)
    usage.admit(F, 0)
    expect(() => {
      usage.admit(F, 1)
    }).toThrow()
  })

  it('counts a hold against the limit until it lands', () => {
    const usage = new StorageUsage(10, 2)
    usage.hold(F, 6)
    expect(usage.pending).toBe(6)
    expect(() => {
      usage.hold(F, 3)
    }).toThrow()
    expect(usage.pending).toBe(6)
    usage.land(6, 4)
    expect([usage.used, usage.pending]).toEqual([6, 0])
  })

  it('only takes a hold out when it lands on an uncounted usage', () => {
    const usage = new StorageUsage(10)
    usage.pending = 5
    usage.land(5, 5)
    expect([usage.used, usage.pending]).toEqual([null, 0])
  })

  it('reports the quota row df prints, never negative room', () => {
    expect(new StorageUsage(10, 4).report()).toEqual({
      state: CapacityState.QUOTA,
      total: 10,
      used: 4,
      available: 6,
    })
    expect(new StorageUsage(10).report()).toEqual({ state: CapacityState.UNKNOWN })
    expect(new StorageUsage(10, 15).report().available).toBe(0)
  })

  it('reads a backend setting through storageUsage', () => {
    expect(storageUsage('ram', null)).toBeNull()
    expect(storageUsage('ram', undefined)).toBeNull()
    const usage = storageUsage('ram', '1K', 0)
    expect([usage?.limit, usage?.used]).toEqual([1024, 0])
    expect(() => storageUsage('disk', '5T')).toThrow(
      new VFSConfigError('disk: capacity must be a size like 100MB, got "5T"'),
    )
  })
})

describe('charge', () => {
  it('reserves only what a replacement adds past the bytes it replaces', async () => {
    const sizes = new Map([['/data/f', 10]])
    const sizeOf = (p: PathSpec): Promise<number> => Promise.resolve(sizes.get(p.virtual) ?? 0)
    const count = (): Promise<number> => Promise.resolve(10)
    const usage = new StorageUsage(10)
    await charge(usage, F, sizeOf, count, (held) => {
      expect(held.stream(new Uint8Array(1))).toHaveLength(1)
      expect(usage.pending).toBe(0)
      sizes.set('/data/f', 1)
      return Promise.resolve()
    })
    expect(usage.used).toBe(1)
    await expect(
      charge(usage, F, sizeOf, count, (held) => {
        held.stream(new Uint8Array(10), true)
        return Promise.resolve()
      }),
    ).rejects.toMatchObject({ code: 'EDQUOT' })
  })

  it('recounts overlapping writes once none is in flight', async () => {
    let calls = 0
    const sizes = new Map([['/data/d/f', 4]])
    const sizeOf = (p: PathSpec): Promise<number> => {
      let n = 0
      for (const [k, v] of sizes) if (k === p.virtual || k.startsWith(p.virtual + '/')) n += v
      return Promise.resolve(n)
    }
    const count = (): Promise<number> => {
      calls += 1
      let n = 0
      for (const v of sizes.values()) n += v
      return Promise.resolve(n)
    }
    const usage = new StorageUsage(10)
    await charge(usage, PathSpec.fromStrPath('/data/d'), sizeOf, count, async () => {
      await charge(usage, PathSpec.fromStrPath('/data/d/f'), sizeOf, count, () => {
        sizes.clear()
        return Promise.resolve()
      })
      expect(usage.dirty).toBe(true)
    })
    expect([calls, usage.used]).toEqual([1, -4])
    await charge(usage, F, sizeOf, count, () => Promise.resolve())
    expect([calls, usage.used, usage.dirty]).toEqual([2, 0, false])
  })

  it('drops the credit of a replacement once a folder move overlaps it', async () => {
    const sizes = new Map([['/data/d/f', 10]])
    const sizeOf = (p: PathSpec): Promise<number> => {
      let n = 0
      for (const [k, v] of sizes) if (k === p.virtual || k.startsWith(p.virtual + '/')) n += v
      return Promise.resolve(n)
    }
    const count = (): Promise<number> => sizeOf(PathSpec.fromStrPath('/data'))
    const usage = new StorageUsage(10)
    const file = PathSpec.fromStrPath('/data/d/f')
    await expect(
      charge(usage, file, sizeOf, count, async (held) => {
        await charge(usage, PathSpec.fromStrPath('/data/d'), sizeOf, count, () =>
          charge(usage, PathSpec.fromStrPath('/data/saved'), sizeOf, count, () => {
            sizes.set('/data/saved/f', 10)
            sizes.delete('/data/d/f')
            return Promise.resolve()
          }),
        )
        expect(held.contended).toBe(true)
        held.stream(new Uint8Array(10))
      }),
    ).rejects.toMatchObject({ code: 'EDQUOT' })
  })

  it('waits for a write in flight before a recount it asked for', async () => {
    const zero = (): Promise<number> => Promise.resolve(0)
    const usage = new StorageUsage(10)
    await charge(usage, F, zero, zero, async (held) => {
      usage.stale()
      await usage.counted(zero)
      held.hold(3)
      expect(usage.pending).toBe(3)
    })
    expect(usage.dirty).toBe(true)
  })
})
