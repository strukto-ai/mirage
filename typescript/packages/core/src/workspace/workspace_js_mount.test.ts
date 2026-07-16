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
import { makeWorkspace, stdoutStr } from './fixtures/workspace_fixture.ts'

// The quickjs runtime's `std.open`/`os.readdir` bridge to the workspace
// dispatch, so sandboxed JS reaches mounts the same way python3 does.
describe('node/js: workspace mount access', () => {
  it('std.open reads a file the shell wrote', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('echo hello-from-shell > /ram/in.txt')
    const io = await ws.execute(
      "js -e \"const f = std.open('/ram/in.txt', 'r'); console.log(f.readAsString().trim().toUpperCase()); f.close()\"",
    )
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('HELLO-FROM-SHELL\n')
    await ws.close()
  }, 60_000)

  it('std.open writes a file cat can read back', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute(
      "js -e \"const f = std.open('/ram/out.txt', 'w'); f.puts('js-wrote-this'); f.close()\"",
    )
    expect(io.exitCode).toBe(0)
    const back = await ws.execute('cat /ram/out.txt')
    expect(stdoutStr(back)).toBe('js-wrote-this')
    await ws.close()
  }, 60_000)

  it('os.readdir lists files written into a fresh subdir', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('mkdir /ram/dir')
    await ws.execute('echo a > /ram/dir/a.txt')
    await ws.execute('echo b > /ram/dir/b.txt')
    const io = await ws.execute(
      "js -e \"const [names] = os.readdir('/ram/dir'); console.log(names.filter((n) => !n.startsWith('.')).sort().join(','))\"",
    )
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('a.txt,b.txt\n')
    await ws.close()
  }, 60_000)

  it('a host path outside any mount is invisible (std.open returns null)', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute("js -e \"console.log(std.open('/etc/passwd', 'r') === null)\"")
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('true\n')
    await ws.close()
  }, 60_000)

  it('a session narrowed to read denies writes (std.open returns null)', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('echo seeded > /ram/seed.txt')
    ws.createSession('narrow', { mounts: { '/ram': 'read' } })
    const io = await ws.execute(
      "js -e \"const f = std.open('/ram/blocked.txt', 'w'); console.log(f === null ? 'denied' : 'WROTE')\"",
      { sessionId: 'narrow' },
    )
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('denied\n')
    const check = await ws.execute('cat /ram/blocked.txt', { sessionId: 'narrow' })
    expect(check.exitCode).not.toBe(0)
    // The narrowed session still reads.
    const read = await ws.execute(
      "js -e \"const f = std.open('/ram/seed.txt', 'r'); console.log(f.readAsString().trim()); f.close()\"",
      { sessionId: 'narrow' },
    )
    expect(stdoutStr(read)).toBe('seeded\n')
    await ws.close()
  }, 60_000)

  it('reads its own writes after close within a run (whole-file buffering)', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute(
      "js -e \"const w = std.open('/ram/live.txt', 'w'); w.puts('v1'); w.close(); const r = std.open('/ram/live.txt', 'r'); console.log(r.readAsString()); r.close()\"",
    )
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('v1\n')
    await ws.close()
  }, 60_000)
})
