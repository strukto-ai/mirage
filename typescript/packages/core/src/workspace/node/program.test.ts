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
import { RAMResource } from '../../resource/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { getTestParser, stderrStr } from '../fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace.ts'

async function makeWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const ws = new Workspace(
    { '/': new RAMResource() },
    { mode: MountMode.WRITE, shellParser: parser },
  )
  await ws.execute('mkdir -p /data/sub')
  await ws.execute('echo hi > /data/sub/x.txt')
  await ws.execute('cd /data')
  return ws
}

describe('drain error spelling', () => {
  it('respells a relative operand as typed', async () => {
    // cat of a directory errors on the first lazy pull, past the eager
    // chokepoint; the drain must still report the operand as typed.
    const ws = await makeWs()
    const io = await ws.execute('cat sub')
    expect(io.exitCode).toBe(1)
    expect(stderrStr(io)).toMatch(/^cat: sub: /)
  })

  it('keeps an absolute operand absolute', async () => {
    const ws = await makeWs()
    const io = await ws.execute('cat /data/sub')
    expect(io.exitCode).toBe(1)
    expect(stderrStr(io)).toMatch(/^cat: \/data\/sub: /)
  })

  it('eager errors respell the relative operand', async () => {
    const ws = await makeWs()
    const io = await ws.execute('cat sub/missing.txt')
    expect(io.exitCode).toBe(1)
    expect(stderrStr(io)).toBe('cat: sub/missing.txt: No such file or directory\n')
  })
})
