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
import { materialize } from '../../io/types.ts'
import { RAMStore } from '../../vfs/ram/store.ts'
import { DevFiles, DevStore } from '../../vfs/dev/store.ts'
import { PathSpec } from '../../types.ts'
import { DevicePipe } from '../dev/pipe.ts'
import { pwrite } from './pwrite.ts'

const ENC = new TextEncoder()
const PATH = new PathSpec({ virtual: '/f.txt', directory: '/', vfsPath: 'f.txt' })
const FD = new PathSpec({ virtual: '/dev/fd/63', directory: '/dev/fd/', vfsPath: 'fd/63' })

describe('pwrite', () => {
  it('keeps the bytes outside the window', async () => {
    const accessor = new RAMAccessor(new RAMStore())
    accessor.store.files.set('/f.txt', ENC.encode('hello'))
    await pwrite(accessor, PATH, ENC.encode('XY'), 1)
    expect(accessor.store.files.get('/f.txt')).toEqual(ENC.encode('hXYlo'))
    expect(accessor.store.modified.get('/f.txt')?.endsWith('Z')).toBe(true)
  })

  it('fills zeros past the end and creates the file', async () => {
    const accessor = new RAMAccessor(new RAMStore())
    await pwrite(accessor, PATH, ENC.encode('z'), 3)
    expect([...(accessor.store.files.get('/f.txt') ?? [])]).toEqual([0, 0, 0, 122])
  })

  it('refuses a missing parent', async () => {
    const accessor = new RAMAccessor(new RAMStore())
    const nested = new PathSpec({ virtual: '/no/f.txt', directory: '/no/', vfsPath: 'no/f.txt' })
    await expect(pwrite(accessor, nested, ENC.encode('x'), 0)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

describe('pwrite to a pipe', () => {
  it('pwrite to a pipe delivers in write order', async () => {
    const store = new DevStore(new DevFiles('owner'))
    const accessor = new RAMAccessor(store as unknown as RAMStore)
    const target = new DevicePipe(false)
    const [path] = store.files.allocateInput(target)
    expect(path).toBe(FD.virtual)
    const consumed = materialize(target.pipe.stream())
    await pwrite(accessor, FD, ENC.encode('first '), 0)
    await pwrite(accessor, FD, ENC.encode('second'), 0)
    target.pipe.end()
    expect(new TextDecoder().decode(await consumed)).toBe('first second')
    expect(store.modified.has('/fd/63')).toBe(false)
  })
})

describe('pwrite to a discarding device', () => {
  it('pads nothing up to its offset', async () => {
    const store = new DevStore(new DevFiles('owner'))
    const accessor = new RAMAccessor(store as unknown as RAMStore)
    const nul = new PathSpec({ virtual: '/dev/null', directory: '/dev/', vfsPath: 'null' })
    await pwrite(accessor, nul, ENC.encode('x'), Number.MAX_SAFE_INTEGER)
    expect(store.files.get('/null')).toEqual(new Uint8Array())
  })
})
