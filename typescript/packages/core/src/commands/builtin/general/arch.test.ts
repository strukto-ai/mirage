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

// Pinned on coreutils 9.7.
it('arch', async () => {
  const ws = new Workspace({ '/d': new RAMVFS() }, { mode: MountMode.WRITE })
  const io = await ws.shell('arch; arch x; echo rc=$?')
  await ws.close()
  expect([io.stdoutText, io.stderrText, io.exitCode]).toEqual([
    'x86_64\nrc=1\n',
    "arch: extra operand 'x'\nTry 'arch --help' for more information.\n",
    0,
  ])
})
