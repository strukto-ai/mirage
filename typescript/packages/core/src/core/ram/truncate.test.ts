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
import { RAMAccessor } from '../../accessor/ram.ts'
import { RAMStore } from '../../vfs/ram/store.ts'
import { DevFiles, DevStore } from '../../vfs/dev/store.ts'
import { PathSpec } from '../../types.ts'
import { DevicePipe } from '../dev/pipe.ts'
import { truncate } from './truncate.ts'
import { capped, ramPath, tableBytes } from '../../test-utils.ts'

const FD = new PathSpec({ virtual: '/dev/fd/63', directory: '/dev/fd/', vfsPath: 'fd/63' })

describe('truncate', () => {
  it('truncate to zero empties the file', async () => {
    const store = new RAMStore()
    store.files.set('/t.txt', new TextEncoder().encode('previous'))
    await truncate(new RAMAccessor(store), PathSpec.fromStrPath('/t.txt'), 0)
    expect(store.files.get('/t.txt')?.byteLength).toBe(0)
  })

  it.each([true, false])('truncate of a pipe is EINVAL (readable %s)', async (readable) => {
    const store = new DevStore(new DevFiles('owner'))
    const endpoint = new DevicePipe(readable)
    store.files.allocateInput(endpoint)
    await expect(
      truncate(new RAMAccessor(store as unknown as RAMStore), FD, 0),
    ).rejects.toMatchObject({ code: 'EINVAL' })
    expect(store.files.pipeOf('/fd/63')).toBe(endpoint)
  })
})

describe('length changes against a capacity', () => {
  it('charges its growth', async () => {
    const [acc, usage] = capped(10, { '/f': '123' })
    await truncate(acc, ramPath('/f'), 8)
    expect([usage.used, tableBytes(acc)]).toEqual([8, 8])
    await expect(truncate(acc, ramPath('/f'), 11)).rejects.toMatchObject({ code: 'EDQUOT' })
    expect(acc.store.files.get('/f')?.byteLength).toBe(8)
  })

  it('passes a shortening over the cap', async () => {
    const [acc, usage] = capped(2, { '/f': '1234567890' })
    await truncate(acc, ramPath('/f'), 4)
    expect([usage.used, tableBytes(acc)]).toEqual([4, 4])
  })

  it('refuses a sparse length past the cap before it builds', async () => {
    const [acc, usage] = capped(10)
    await expect(truncate(acc, ramPath('/f'), 2 ** 40)).rejects.toMatchObject({ code: 'EDQUOT' })
    expect([acc.store.files.has('/f'), usage.used]).toEqual([false, 0])
  })

  it.each([-1, -100, 2.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses length %s with EINVAL and charges nothing',
    async (length) => {
      const [acc, usage] = capped(4, { '/f': '1234' })
      usage.used = 4
      await expect(truncate(acc, ramPath('/f'), length)).rejects.toMatchObject({ code: 'EINVAL' })
      expect([acc.store.files.get('/f')?.byteLength, usage.used, tableBytes(acc)]).toEqual([
        4, 4, 4,
      ])
    },
  )

  it('charges nothing for a no-create change on a missing file', async () => {
    const [acc, usage] = capped(10)
    await truncate(acc, ramPath('/f'), 4, true)
    expect([acc.store.files.has('/f'), usage.used]).toEqual([false, 0])
  })
})
