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

import { beforeEach, describe, expect, it } from 'vitest'
import { MountMode, RAMVFS, Workspace } from '@struktoai/mirage-node'
import { MirageToolOperations } from './tool-operations.ts'

let ws: Workspace
let ops: MirageToolOperations

beforeEach(() => {
  ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
  ops = new MirageToolOperations(ws)
})

describe('grep', () => {
  it('reports matches as a success', async () => {
    await ws.vfs.writeFile('/search.txt', 'hello world\ngoodbye world\n')
    const result = await ops.grep('hello', '/')
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('hello') as string })
    expect(result.isError).toBeUndefined()
  })

  it('reports no match as a success', async () => {
    // grep exits 1 when nothing matched. That is the empty answer, not
    // a broken search, so the agent must not be told the call failed.
    await ws.vfs.writeFile('/search.txt', 'hello world\n')
    const result = await ops.grep('nothing-matches-this', '/')
    expect(result.isError).toBeUndefined()
  })

  it('reports a real failure as an error', async () => {
    // An unreadable path exits 2. Reported as a success, the diagnostic
    // would read to the agent like a search that found nothing.
    const result = await ops.grep('hello', '/nope.txt')
    expect(result.isError).toBe(true)
  })
})

describe('edit', () => {
  it('refuses an edit to a file that changed since it was read', async () => {
    await ws.vfs.writeFile('/a.txt', 'hello world')
    await ops.read('/a.txt')
    await ws.vfs.writeFile('/a.txt', 'hello there')
    const result = await ops.edit('/a.txt', 'hello', 'goodbye')
    expect(result.isError).toBe(true)
    expect(await ws.vfs.readFileText('/a.txt')).toBe('hello there')
  })

  it('overwrites when stale-write protection is off', async () => {
    const unchecked = new MirageToolOperations(ws, { staleWriteProtection: false })
    await ws.vfs.writeFile('/a.txt', 'hello world')
    await unchecked.read('/a.txt')
    await ws.vfs.writeFile('/a.txt', 'hello there')
    const result = await unchecked.edit('/a.txt', 'hello', 'goodbye')
    expect(result.isError).toBeUndefined()
    expect(await ws.vfs.readFileText('/a.txt')).toBe('goodbye there')
  })
})
