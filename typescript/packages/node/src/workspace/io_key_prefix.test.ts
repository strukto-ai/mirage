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
import { MountMode, RAMResource, type IOResult } from '@struktoai/mirage-core'
import { Workspace } from '../workspace.ts'

function captureIo(ws: Workspace): IOResult[] {
  const captured: IOResult[] = []
  const namespace = (ws as unknown as { namespace: { applyIo: (io: IOResult) => Promise<void> } })
    .namespace
  const orig = namespace.applyIo.bind(namespace)
  namespace.applyIo = async (io: IOResult) => {
    captured.push(io)
    return orig(io)
  }
  return captured
}

function assertSinglePrefix(captured: IOResult[]): void {
  for (const io of captured) {
    const keys = [...Object.keys(io.writes), ...Object.keys(io.reads), ...io.cache]
    for (const key of keys) {
      if (key.startsWith('/dev/')) continue
      expect(key.startsWith('/data/'), key).toBe(true)
      expect(key.startsWith('/data/data/'), key).toBe(false)
    }
  }
}

describe('io key prefix convention', () => {
  it.each([
    ['tee /data/t.txt > /dev/null', 'x\ny\n'],
    ['csplit -f /data/cs_ /data/seed.txt 2', null],
    ['cp /data/seed.txt /data/copy.txt', null],
    ['grep x /data/seed.txt > /data/red.txt', null],
    ['cat /data/seed.txt >> /data/app.txt', null],
    ['cat /data/seed.txt | tee /data/piped.txt > /dev/null', null],
  ])('records mount-relative keys for %s', async (cmd, stdin) => {
    const ws = new Workspace({ '/data': new RAMResource() }, { mode: MountMode.WRITE })
    await ws.execute('tee /data/seed.txt > /dev/null', {
      stdin: new TextEncoder().encode('x\ny\n'),
    })
    const captured = captureIo(ws)
    const result = await ws.execute(
      cmd,
      stdin !== null ? { stdin: new TextEncoder().encode(stdin) } : undefined,
    )
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0)
    assertSinglePrefix(captured)
    await ws.close()
  })

  it('2> records a mount-relative key even when the command fails', async () => {
    const ws = new Workspace({ '/data': new RAMResource() }, { mode: MountMode.WRITE })
    const captured = captureIo(ws)
    const result = await ws.execute('cat /data/missing.txt 2> /data/err.txt')
    expect(result.exitCode).not.toBe(0)
    assertSinglePrefix(captured)
    const back = await ws.execute('cat /data/err.txt')
    expect(back.exitCode).toBe(0)
    expect(new TextDecoder().decode(back.stdout)).toContain('missing.txt')
    await ws.close()
  })

  it('csplit -f with a mount path writes parts inside the mount', async () => {
    const ws = new Workspace({ '/data': new RAMResource() }, { mode: MountMode.WRITE })
    await ws.execute('tee /data/seed.txt > /dev/null', {
      stdin: new TextEncoder().encode('x\ny\n'),
    })
    const result = await ws.execute('csplit -f /data/cs_ /data/seed.txt 2')
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0)
    const part = await ws.execute('cat /data/cs_00')
    expect(part.exitCode).toBe(0)
    expect(new TextDecoder().decode(part.stdout)).toBe('x\n')
    await ws.close()
  })
})
