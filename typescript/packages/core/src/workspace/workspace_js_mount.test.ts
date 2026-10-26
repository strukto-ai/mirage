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
import { makeWorkspace, stdoutStr } from '../../tests/workspace/fixtures/workspace_fixture.ts'

// The quickjs runtime's `std.open`/`os.readdir` bridge to the workspace
// dispatch, so sandboxed JS reaches mounts the same way python3 does.
describe('node/js: workspace mount access', () => {
  it('a session narrowed to read denies writes (std.open returns null)', async () => {
    const { ws } = makeWorkspace()
    await ws.shell('echo seeded > /ram/seed.txt')
    ws.createSession('narrow', { mounts: { '/ram': 'read' } })
    const io = await ws.shell(
      "js -e \"const f = std.open('/ram/blocked.txt', 'w'); console.log(f === null ? 'denied' : 'WROTE')\"",
      { sessionId: 'narrow' },
    )
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('denied\n')
    const check = await ws.shell('cat /ram/blocked.txt', { sessionId: 'narrow' })
    expect(check.exitCode).not.toBe(0)
    // The narrowed session still reads.
    const read = await ws.shell(
      "js -e \"const f = std.open('/ram/seed.txt', 'r'); console.log(f.readAsString().trim()); f.close()\"",
      { sessionId: 'narrow' },
    )
    expect(stdoutStr(read)).toBe('seeded\n')
    await ws.close()
  }, 60_000)
})
