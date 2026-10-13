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

import { expect, it } from 'vitest'
import { RAMAccessor } from '../../accessor/ram.ts'
import { DevFiles, DevStore } from '../../vfs/dev/store.ts'
import type { RAMStore } from '../../vfs/ram/store.ts'
import { FileType, PathSpec } from '../../types.ts'
import { DevicePipe } from './pipe.ts'
import { stat } from './stat.ts'

const FD = new PathSpec({ virtual: '/dev/fd/63', directory: '/dev/fd/', vfsPath: 'fd/63' })

it.each([
  [{}, null, [0o600, null, null, null, null]],
  [
    { mode: 0o640, uid: 7, gid: 8, atime: '2020-01-02T03:04:05Z' },
    '2020-01-02T03:04:06Z',
    [0o640, 7, 8, '2020-01-02T03:04:05Z', '2020-01-02T03:04:06Z'],
  ],
] as const)('fifo reports its stored attrs: %o', async (attrs, modified, expected) => {
  const devices = new DevStore(new DevFiles('owner'))
  devices.files.allocateInput(new DevicePipe(true))
  devices.attrs.set('/fd/63', { ...attrs })
  if (modified !== null) devices.modified.set('/fd/63', modified)
  const s = await stat(new RAMAccessor(devices as unknown as RAMStore), FD)
  expect([s.name, s.type, s.size]).toEqual(['63', FileType.FIFO, null])
  expect([s.mode, s.uid, s.gid, s.atime, s.modified]).toEqual(expected)
})
