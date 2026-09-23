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
import { OpsRegistry } from '../../../ops/registry.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { MountMode } from '../../../types.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'

async function makeWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const ram = new RAMVFS()
  const registry = new OpsRegistry()
  registry.registerVfs(ram)
  return new Workspace(
    { '/ram': ram },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
}

describe('history builtin', () => {
  it('lists recent commands with line numbers', async () => {
    const ws = await makeWs()
    await ws.shell('echo hello')
    await ws.shell('echo world')
    const io = await ws.shell('history')
    expect(io.exitCode).toBe(0)
    expect(io.stdoutText).toContain('echo hello')
    expect(io.stdoutText).toContain('echo world')
    await ws.close()
  })

  it('history N returns last N entries', async () => {
    const ws = await makeWs()
    await ws.shell('echo a')
    await ws.shell('echo b')
    await ws.shell('echo c')
    const io = await ws.shell('history 2')
    const lines = io.stdoutText
      .trim()
      .split('\n')
      .filter((l) => l !== '')
    expect(lines).toHaveLength(2)
    expect(lines[lines.length - 1]).toContain('echo c')
    await ws.close()
  })

  it('history -c clears the buffer', async () => {
    const ws = await makeWs()
    await ws.shell('echo a')
    await ws.shell('echo b')
    const clearIo = await ws.shell('history -c')
    expect(clearIo.exitCode).toBe(0)
    const io = await ws.shell('history')
    const lines = io.stdoutText
      .trim()
      .split('\n')
      .filter((l) => l !== '')
    expect(lines).toHaveLength(1)
    expect(lines[lines.length - 1]).toContain('history')
    await ws.close()
  })

  it('rejects non-numeric argument', async () => {
    const ws = await makeWs()
    await ws.shell('echo a')
    const io = await ws.shell('history abc')
    expect(io.exitCode).toBe(1)
    expect(io.stderrText).toMatch(/numeric/)
    await ws.close()
  })

  it('isolates entries per session', async () => {
    const ws = await makeWs()
    ws.createSession('alice')
    ws.createSession('bob')
    await ws.shell('echo from-alice', { sessionId: 'alice' })
    await ws.shell('echo from-bob', { sessionId: 'bob' })
    const a = await ws.shell('history', { sessionId: 'alice' })
    expect(a.stdoutText).toContain('from-alice')
    expect(a.stdoutText).not.toContain('from-bob')
    const b = await ws.shell('history', { sessionId: 'bob' })
    expect(b.stdoutText).toContain('from-bob')
    expect(b.stdoutText).not.toContain('from-alice')
    await ws.close()
  })
})
