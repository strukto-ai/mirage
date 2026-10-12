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
import { RAMVFS } from '../../vfs/ram/ram.ts'
import type { RAMStore } from '../../vfs/ram/store.ts'
import { FileType, MountMode, PathSpec } from '../../types.ts'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { DevicePipe } from './pipe.ts'
import { stat } from './stat.ts'

const FD = new PathSpec({ virtual: '/dev/fd/63', directory: '/dev/fd/', vfsPath: 'fd/63' })

function store(): DevStore {
  const devices = new DevStore(new DevFiles('owner'))
  devices.files.allocateInput(new DevicePipe(true))
  return devices
}

function accessor(devices: DevStore): RAMAccessor {
  return new RAMAccessor(devices as unknown as RAMStore)
}

it('fifo without attrs is rw for its owner', async () => {
  const s = await stat(accessor(store()), FD)
  expect([s.name, s.type, s.size, s.mode]).toEqual(['63', FileType.FIFO, null, 0o600])
  expect([s.uid, s.gid, s.atime, s.modified]).toEqual([null, null, null, null])
})

it('fifo reports its stored attrs', async () => {
  const devices = store()
  devices.attrs.set('/fd/63', { mode: 0o640, uid: 7, gid: 8, atime: '2020-01-02T03:04:05Z' })
  devices.modified.set('/fd/63', '2020-01-02T03:04:06Z')
  const s = await stat(accessor(devices), FD)
  expect([s.mode, s.uid, s.gid]).toEqual([0o640, 7, 8])
  expect([s.atime, s.modified]).toEqual(['2020-01-02T03:04:05Z', '2020-01-02T03:04:06Z'])
})

it.each([
  ["stat -L -c '%F %f %a %A %s' <(true)", 'fifo 1180 600 prw------- 0\n'],
  ['f() { chmod 640 "$1"; stat -L -c \'%a %A\' "$1"; }; f <(true)', '640 prw-r-----\n'],
  ['f() { chmod u+x "$1"; stat -L -c \'%a\' "$1"; }; f <(true)', '700\n'],
  [
    'f() { touch -d \'2020-01-02 03:04:05\' "$1"; stat -L -c \'%y\' "$1"; }; f <(true)',
    '2020-01-02 03:04:05.000000000 +0000\n',
  ],
])('stat of a substitution: %s', async (command, expected) => {
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  try {
    const io = await ws.shell(command)
    expect([io.exitCode, io.stdoutText, io.stderrText]).toEqual([0, expected, ''])
  } finally {
    await ws.close()
  }
})
