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
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'

// A workspace with no agent id has no identity: GNU id's shapes with a dash in
// each slot, and the name lookups fail.
it.each<[string, [string, string, number]]>([
  ['id', ['uid=- gid=- groups=-\n', '', 0]],
  ['id -u', ['-\n', '', 0]],
  ['id -un', ['-\n', 'id: cannot find name for user ID\n', 1]],
  ['id -Gn', ['-\n', 'id: cannot find name for group ID\n', 1]],
])('%s without an identity', async (line, expected) => {
  const ws = new Workspace(
    { '/': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  const io = await ws.shell(line)
  await ws.close()
  expect([io.stdoutText, io.stderrText, io.exitCode]).toEqual(expected)
})
