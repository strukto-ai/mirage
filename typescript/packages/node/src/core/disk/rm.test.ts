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

import { access, chmod, mkdir, writeFile } from 'node:fs/promises'
import { runWithRecording } from '@struktoai/mirage-core/observe/context'
import type { OpRecord } from '@struktoai/mirage-core/observe/record'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DiskAccessor } from '../../accessor/disk.ts'
import { spec, tmpRoot } from '../../../tests/test-utils.ts'
import { rmR } from './rm.ts'

let root: string
let accessor: DiskAccessor
let cleanup: () => void

beforeEach(() => {
  ;({ root, accessor, cleanup } = tmpRoot('mirage-core-disk-rmR-'))
})
afterEach(() => {
  cleanup()
})

describe('core/disk/rm.rmR', () => {
  it('removes a directory recursively', async () => {
    await mkdir(join(root, 'd'))
    await writeFile(join(root, 'd', 'x'), 'x')
    await rmR(accessor, spec('/d'))
    await expect(access(join(root, 'd'))).rejects.toThrow()
  })
  it('removes a single file', async () => {
    await writeFile(join(root, 'x'), '')
    await rmR(accessor, spec('/x'))
    await expect(access(join(root, 'x'))).rejects.toThrow()
  })
  it('is a no-op on missing path (force:true)', async () => {
    await expect(rmR(accessor, spec('/missing'))).resolves.toBeUndefined()
  })
})

// Root ignores directory modes.
describe.skipIf(process.getuid?.() === 0)('core/disk/rm.rmR rows', () => {
  async function rmRow(locked: string, mode: number): Promise<OpRecord | undefined> {
    await mkdir(join(root, 'd', 's'), { recursive: true })
    await writeFile(join(root, 'd', 'f'), 'f')
    await writeFile(join(root, 'd', 's', 'g'), 'g')
    await chmod(join(root, locked), mode)
    try {
      const [, records] = await runWithRecording(async () => {
        await expect(rmR(accessor, spec('/d'))).rejects.toMatchObject({ code: 'EACCES' })
      })
      expect(records).toHaveLength(1)
      return records[0]
    } finally {
      await chmod(join(root, locked), 0o700)
    }
  }

  it('records a failed row when it removed nothing', async () => {
    const row = await rmRow('d', 0)
    await expect(access(join(root, 'd', 'f'))).resolves.toBeUndefined()
    expect(row).toMatchObject({ status: 'failed', changed: false, errno: 13 })
  })

  it('records partial once it removed an entry', async () => {
    const row = await rmRow('d/s', 0o500)
    await expect(access(join(root, 'd', 'f'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(row).toMatchObject({ status: 'partial', changed: true, errno: 13 })
  })

  it('records failed when its first unlink is refused', async () => {
    await mkdir(join(root, 'e'))
    await writeFile(join(root, 'e', 'f'), 'f')
    await chmod(join(root, 'e'), 0o500)
    try {
      const [, records] = await runWithRecording(async () => {
        await expect(rmR(accessor, spec('/e'))).rejects.toMatchObject({ code: 'EACCES' })
      })
      await expect(access(join(root, 'e', 'f'))).resolves.toBeUndefined()
      expect(records).toMatchObject([{ status: 'failed', changed: false, errno: 13 }])
    } finally {
      await chmod(join(root, 'e'), 0o700)
    }
  })

  it('records failed for an empty directory its parent keeps', async () => {
    await mkdir(join(root, 'x', 'e'), { recursive: true })
    await chmod(join(root, 'x'), 0o500)
    try {
      const [, records] = await runWithRecording(async () => {
        await expect(rmR(accessor, spec('/x/e'))).rejects.toMatchObject({ code: 'EACCES' })
      })
      await expect(access(join(root, 'x', 'e'))).resolves.toBeUndefined()
      expect(records).toMatchObject([{ status: 'failed', changed: false, errno: 13 }])
    } finally {
      await chmod(join(root, 'x'), 0o700)
    }
  })
})
