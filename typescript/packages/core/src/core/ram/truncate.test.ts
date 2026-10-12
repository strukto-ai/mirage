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
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { MountMode, PathSpec } from '../../types.ts'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { DevicePipe } from '../dev/pipe.ts'
import { truncate } from './truncate.ts'

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

  it.each([
    ['truncate -s 0 >(cat); echo "st=$?"', 'st=1\n'],
    ['f() { : > "$1"; echo "st=$?"; }; f >(cat)', 'st=0\n'],
  ])('truncating a substitution fails but opening it does not: %s', async (command, expected) => {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: await getTestParser() },
    )
    try {
      const io = await ws.shell(command)
      expect([io.exitCode, io.stdoutText]).toEqual([0, expected])
    } finally {
      await ws.close()
    }
  })
})
