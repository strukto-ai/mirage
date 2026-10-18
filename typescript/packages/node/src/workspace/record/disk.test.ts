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

import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { DiskRecordClient } from './disk.ts'

vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof fs>()
  return { ...real, open: vi.fn(real.open) }
})

it('releases the lock and handle when writing the owner fails', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'mirage-record-'))
  try {
    const client = new DiskRecordClient(root, '')
    const lock = `${client.path('record')}.lock`
    const handle = await fs.open(lock, 'wx')
    vi.spyOn(handle, 'write').mockRejectedValueOnce(new Error('write failed'))
    vi.mocked(fs.open).mockResolvedValueOnce(handle)
    await expect(client.lock('record')).rejects.toThrow('write failed')
    await expect(fs.stat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' })
    await client.unlock('record', await client.lock('record'))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
