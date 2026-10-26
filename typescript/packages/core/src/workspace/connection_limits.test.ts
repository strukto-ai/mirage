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
import { RAMVFS } from '../vfs/ram/ram.ts'
import { Limit, MountMode, OnExceed } from '../types.ts'
import { Workspace } from './workspace/workspace.ts'

const DEC = new TextDecoder()

async function buildWs(): Promise<Workspace> {
  const a = new RAMVFS()
  const b = new RAMVFS()
  const ws = new Workspace(
    {
      '/a/': [a, MountMode.WRITE, { cat: new Limit({ maxLines: 4 }) }],
      '/b/': [b, MountMode.WRITE, { cat: new Limit({ maxLines: 2, onExceed: OnExceed.ERROR }) }],
    },
    {
      mode: MountMode.WRITE,
    },
  )
  await ws.shell("printf '1\\n2\\n3\\n4\\n5\\n' > /a/f.txt")
  await ws.shell("printf '6\\n7\\n8\\n9\\n10\\n' > /b/f.txt")
  return ws
}

describe('connection limit (src)', () => {
  it('single cat /a truncates to 4', async () => {
    const ws = await buildWs()
    const res = await ws.shell('cat /a/f.txt')
    await ws.close()
    expect(DEC.decode(res.stdout)).toBe('1\n2\n3\n4\n')
    expect(DEC.decode(res.stderr)).toContain('truncated')
  })

  it('semicolon: each command applies its own limit', async () => {
    const ws = await buildWs()
    const res = await ws.shell('cat /b/f.txt ; cat /a/f.txt')
    await ws.close()
    expect(DEC.decode(res.stdout)).toBe('1\n2\n3\n4\n')
    expect(DEC.decode(res.stderr)).toContain('truncated')
  })

  it('or: rightmost /a limit caps to 4', async () => {
    const ws = await buildWs()
    const res = await ws.shell('false || cat /a/f.txt')
    await ws.close()
    expect(DEC.decode(res.stdout)).toBe('1\n2\n3\n4\n')
    expect(DEC.decode(res.stderr)).toContain('truncated')
  })

  it('and: rightmost /b limit errors', async () => {
    const ws = await buildWs()
    const res = await ws.shell('cat /a/f.txt && cat /b/f.txt')
    await ws.close()
    expect(res.exitCode).toBe(1)
    expect(DEC.decode(res.stderr)).toContain('truncated')
  })

  it('subshell: each command applies its own limit', async () => {
    const ws = await buildWs()
    const res = await ws.shell('( cat /b/f.txt ; cat /a/f.txt )')
    await ws.close()
    expect(DEC.decode(res.stdout)).toBe('1\n2\n3\n4\n')
    expect(DEC.decode(res.stderr)).toContain('truncated')
  })

  it('repeated read keeps the per-mount limit (no cache-mount fallthrough)', async () => {
    const ws = await buildWs()
    const first = await ws.shell('cat /a/f.txt')
    const second = await ws.shell('cat /a/f.txt')
    await ws.close()
    expect(DEC.decode(first.stdout)).toBe('1\n2\n3\n4\n')
    expect(DEC.decode(second.stdout)).toBe('1\n2\n3\n4\n')
    expect(DEC.decode(second.stderr)).toContain('truncated')
  })
})
