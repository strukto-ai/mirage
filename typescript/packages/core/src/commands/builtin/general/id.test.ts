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
import { MountMode } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'

// A session with no profile is root, as debian:stable-slim's root prints.
it.each<[string, [string, string, number]]>([
  ['id', ['uid=0(root) gid=0(root) groups=0(root)\n', '', 0]],
  ['id -u', ['0\n', '', 0]],
  ['id -un', ['root\n', '', 0]],
  ['id -Gn', ['root\n', '', 0]],
  ['id nobody', ['uid=65534(nobody) gid=65534(nogroup) groups=65534(nogroup)\n', '', 0]],
  ['id 1000', ['', "id: '1000': no such user\n", 1]],
])('%s without a profile is root', async (line, expected) => {
  const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
  const io = await ws.shell(line)
  await ws.close()
  expect([io.stdoutText, io.stderrText, io.exitCode]).toEqual(expected)
})
