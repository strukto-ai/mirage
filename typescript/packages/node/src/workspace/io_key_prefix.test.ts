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
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import { Workspace } from '../workspace.ts'

describe('io key prefix convention', () => {
  it.each([
    ['tee /data/t.txt > /dev/null', 'x\ny\n'],
    ['csplit -f /data/cs_ /data/seed.txt 2', null],
    ['csplit /data/seed.txt 2', null],
    ['split -l 1 /data/seed.txt', null],
    ['cd /data && split -l 1', 'x\ny\n'],
    ['cd /data && csplit - 2', 'x\ny\n'],
    ['cp /data/seed.txt /data/copy.txt', null],
    ['grep x /data/seed.txt > /data/red.txt', null],
    ['cat /data/seed.txt >> /data/app.txt', null],
    ['cat /data/seed.txt | tee /data/piped.txt > /dev/null', null],
  ])('writes inside the mount for %s', async (cmd, stdin) => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.shell('tee /data/seed.txt > /dev/null', {
      stdin: new TextEncoder().encode('x\ny\n'),
    })
    const result = await ws.shell(
      cmd,
      stdin !== null ? { stdin: new TextEncoder().encode(stdin) } : undefined,
    )
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0)
    expect(await ws.vfs.exists('/data/data')).toBe(false)
    await ws.close()
  })

  it('2> writes inside the mount even when the command fails', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    const result = await ws.shell('cat /data/missing.txt 2> /data/err.txt')
    expect(result.exitCode).not.toBe(0)
    const back = await ws.shell('cat /data/err.txt')
    expect(back.exitCode).toBe(0)
    expect(new TextDecoder().decode(back.stdout)).toContain('missing.txt')
    await ws.close()
  })

  it('csplit -f with a mount path writes parts inside the mount', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.shell('tee /data/seed.txt > /dev/null', {
      stdin: new TextEncoder().encode('x\ny\n'),
    })
    const result = await ws.shell('csplit -f /data/cs_ /data/seed.txt 2')
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0)
    const part = await ws.shell('cat /data/cs_00')
    expect(part.exitCode).toBe(0)
    expect(new TextDecoder().decode(part.stdout)).toBe('x\n')
    await ws.close()
  })

  it('csplit from stdin writes its part inside the mount', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    const result = await ws.shell('cd /data && csplit - 2', {
      stdin: new TextEncoder().encode('x\ny\n'),
    })
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0)
    const part = await ws.shell('cat /data/xx00')
    expect(part.exitCode).toBe(0)
    expect(new TextDecoder().decode(part.stdout)).toBe('x\n')
    await ws.close()
  })
})
