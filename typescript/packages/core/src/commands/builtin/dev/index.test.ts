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
import { MountMode } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { dispatched } from '../../../test-utils.ts'

describe('a file in /dev is read at the dispatcher', () => {
  // cat and head read /dev in ranges, which /dev/zero answers without end;
  // each range is a dispatcher read, so the gates judge the file before any
  // byte is printed.
  it.each(['cat', 'head -n 1'])('%s', async (command) => {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.WRITE,
      },
    )
    try {
      await ws.shell('echo s > /dev/secret')
      const seen = dispatched(ws)
      const read = await ws.shell(`${command} /dev/secret`)
      expect(read.stdoutText).toBe('s\n')
      expect(seen).toContainEqual(['read', '/dev/secret'])
      const zero = await ws.shell(`${command} /dev/zero | head -c 3 | wc -c`)
      expect(zero.stdoutText).toBe('3\n')
    } finally {
      await ws.close()
    }
  })
})
