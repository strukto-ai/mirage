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

import { chmod, open, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiskAccessor } from '../../accessor/disk.ts'
import { spec, tmpRoot } from '../../../tests/test-utils.ts'
import { pwrite } from './pwrite.ts'

const ENC = new TextEncoder()

let root: string
let accessor: DiskAccessor
let cleanup: () => void

beforeEach(() => {
  ;({ root, accessor, cleanup } = tmpRoot('mirage-core-disk-pwrite-'))
})
afterEach(() => {
  cleanup()
})

describe('core/disk/pwrite', () => {
  it('keeps the bytes outside the window', async () => {
    await writeFile(join(root, 'f'), 'hello')
    await pwrite(accessor, spec('/f'), ENC.encode('XY'), 1)
    expect(await readFile(join(root, 'f'), 'utf-8')).toBe('hXYlo')
  })

  it('creates a missing file and fills the gap with zeros', async () => {
    await pwrite(accessor, spec('/f'), ENC.encode('z'), 3)
    expect([...(await readFile(join(root, 'f')))]).toEqual([0, 0, 0, 122])
  })

  it('reads nothing back, so a write-only file takes it', async () => {
    await writeFile(join(root, 'f'), 'abcdef')
    await chmod(join(root, 'f'), 0o200)
    try {
      await pwrite(accessor, spec('/f'), ENC.encode('Z'), 5)
    } finally {
      await chmod(join(root, 'f'), 0o600)
    }
    expect(await readFile(join(root, 'f'), 'utf-8')).toBe('abcdeZ')
  })

  it('finishes a write the file took only part of', async () => {
    await writeFile(join(root, 'f'), 'hello')
    const probe = await open(join(root, 'f'))
    const proto = Object.getPrototypeOf(probe) as {
      write: (...args: unknown[]) => Promise<{ bytesWritten: number }>
    }
    await probe.close()
    const real = proto.write
    const spy = vi.spyOn(proto, 'write').mockImplementation(function (
      this: unknown,
      ...args: unknown[]
    ) {
      const [data, at, length, position] = args as [Uint8Array, number, number, number]
      return real.call(this, data, at, Math.min(length, 2), position)
    })
    try {
      await pwrite(accessor, spec('/f'), ENC.encode('ABCDE'), 1)
      expect(spy).toHaveBeenCalledTimes(3)
    } finally {
      spy.mockRestore()
    }
    expect(await readFile(join(root, 'f'), 'utf-8')).toBe('hABCDE')
  })
})
