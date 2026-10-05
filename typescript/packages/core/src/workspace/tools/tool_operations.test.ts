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
import { MountMode } from '../../types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import { Session } from '../workspace/handle.ts'
import { Workspace } from '../workspace/workspace.ts'
import { MirageToolOperations } from './tool_operations.ts'
import { parseSessionProfile } from '../../policy/profile.ts'
import { runWithSession } from '../../context/session_context.ts'
import { RAMWorkspaceStateStore } from '../store/ram.ts'

let ws: Workspace
let ops: MirageToolOperations

const shellParser = await getTestParser()

beforeEach(() => {
  ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE, shellParser })
  ops = ws.tools
})

describe('grep', () => {
  it('reports matches as a success', async () => {
    await ws.vfs.write('/search.txt', 'hello world\ngoodbye world\n')
    const result = await ops.grep('hello', '/')
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('hello') as string })
    expect(result.isError).toBeUndefined()
  })

  it('reports no match as a success', async () => {
    // grep exits 1 when nothing matched. That is the empty answer, not
    // a broken search, so the agent must not be told the call failed.
    await ws.vfs.write('/search.txt', 'hello world\n')
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
  it('keeps a UTF-8 byte order mark', async () => {
    const encoder = new TextEncoder()
    await ws.vfs.write('/bom.txt', encoder.encode('\uFEFFhello world'))
    const result = await ops.edit('/bom.txt', 'world', 'there')
    expect(result.isError).toBeUndefined()
    expect(await ws.vfs.read('/bom.txt', { raw: true })).toEqual(
      encoder.encode('\uFEFFhello there'),
    )
  })

  it('refuses an edit to a file that changed since it was read', async () => {
    await ws.vfs.write('/a.txt', 'hello world')
    await ops.read('/a.txt')
    await ws.vfs.write('/a.txt', 'hello there')
    const result = await ops.edit('/a.txt', 'hello', 'goodbye')
    expect(result.isError).toBe(true)
    expect(await ws.vfs.cat('/a.txt')).toBe('hello there')
  })

  it('overwrites when stale-write protection is off', async () => {
    const unchecked = new MirageToolOperations(new Session(ws, ws.defaultSessionId), false)
    await ws.vfs.write('/a.txt', 'hello world')
    await unchecked.read('/a.txt')
    await ws.vfs.write('/a.txt', 'hello there')
    const result = await unchecked.edit('/a.txt', 'hello', 'goodbye')
    expect(result.isError).toBeUndefined()
    expect(await ws.vfs.cat('/a.txt')).toBe('goodbye there')
  })
})

describe('glob', () => {
  it('finds files by name under a path', async () => {
    await ops.write('/src/a.ts', 'a')
    await ops.write('/src/deep/b.ts', 'b')
    await ops.write('/src/c.txt', 'c')
    const result = await ops.glob('**/*.ts', '/src')
    expect((result.content[0]?.text ?? '').split(/\s+/).filter(Boolean)).toEqual([
      '/src/a.ts',
      '/src/deep/b.ts',
    ])
    expect(result.isError).not.toBe(true)
  })

  it('matches a pattern with directories in it', async () => {
    await ops.write('/src/deep/b.ts', 'b')
    const result = await ops.glob('src/**/*.ts')
    expect((result.content[0]?.text ?? '').trim()).toBe('/src/deep/b.ts')
  })

  it('follows a link to a file', async () => {
    await ops.write('/src/a.ts', 'a')
    await ops.shell('ln -s /src/a.ts /src/link.ts')
    await ops.shell('ln -s /src/none.ts /src/dangling.ts')
    const result = await ops.glob('*.ts', '/src')
    expect((result.content[0]?.text ?? '').split(/\s+/).filter(Boolean)).toEqual([
      '/src/a.ts',
      '/src/link.ts',
    ])
  })

  it('skips directories', async () => {
    await ops.write('/cache.ts/inner.txt', 'x')
    await ops.write('/src/a.ts', 'a')
    const result = await ops.glob('**/*.ts')
    expect((result.content[0]?.text ?? '').trim()).toBe('/src/a.ts')
  })

  it('matches only the named level', async () => {
    await ops.write('/src/a.ts', 'a')
    await ops.write('/src/deep/b.ts', 'b')
    const result = await ops.glob('*.ts', '/src')
    expect((result.content[0]?.text ?? '').trim()).toBe('/src/a.ts')
  })
})

describe('grep options', () => {
  it('takes the GNU flags', async () => {
    await ops.write('/src/a.py', 'Needle\nhay\n')
    await ops.write('/src/b.txt', 'needle\n')
    const loose = await ops.grep('needle', '/src', { ignoreCase: true, include: '*.py' })
    const names = await ops.grep('needle', '/src', { filesWithMatches: true })
    const counted = await ops.grep('e', '/src/a.py', { count: true })
    const literal = await ops.grep('-dash', '/src')
    expect(loose.content[0]?.text).toBe('/src/a.py:1:Needle\n')
    expect(names.content[0]?.text).toBe('/src/b.txt\n')
    expect(counted.content[0]?.text).toBe('1\n')
    expect(literal.isError).not.toBe(true)
  })
})

describe('write', () => {
  it('refuses an unread file', async () => {
    await ws.vfs.write('/exists.txt', 'first')
    const result = await ops.write('/exists.txt', 'second')
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('read all of it before overwriting it')
    expect(await ws.vfs.cat('/exists.txt')).toBe('first')
  })

  it('refuses a partly read file', async () => {
    await ws.vfs.write('/three.txt', '1\n2\n3\n')
    await ops.read('/three.txt', 0, 1)
    const result = await ops.write('/three.txt', 'x')
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('read all of it before overwriting it')
    expect(await ws.vfs.cat('/three.txt')).toBe('1\n2\n3\n')
  })

  it('overwrites a read file', async () => {
    await ws.vfs.write('/exists.txt', 'first')
    await ops.read('/exists.txt')
    const result = await ops.write('/exists.txt', 'second')
    expect(result.isError).not.toBe(true)
    expect(await ws.vfs.cat('/exists.txt')).toBe('second')
  })

  it('refuses a file changed since it was read', async () => {
    await ws.vfs.write('/exists.txt', 'first')
    await ops.read('/exists.txt')
    await ws.vfs.write('/exists.txt', 'moved')
    const result = await ops.write('/exists.txt', 'second')
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('changed since it was last read')
    expect(await ws.vfs.cat('/exists.txt')).toBe('moved')
  })
})

async function guardedWs(): Promise<Workspace> {
  const ws = new Workspace(
    { '/': new RAMVFS(), '/vault': new RAMVFS(), '/ro': new RAMVFS() },
    {
      mode: MountMode.WRITE,
      shellParser,
      profiles: {
        guarded: parseSessionProfile({
          paths: { hide: ['/vault'] },
          mounts: { '/ro': { mode: 'r' } },
        }),
      },
    },
  )
  await ws.shell('echo key > /vault/key.txt && echo r > /ro/r.txt')
  ws.createSession('agent', { profile: 'guarded' })
  return ws
}

const textOf = (result: { content: { text: string }[] }): string =>
  result.content.map((c) => c.text).join('')

describe('a session', () => {
  it('confines every tool to its profile', async () => {
    const guarded = await guardedWs()
    const ops = new Session(guarded, 'agent').tools
    const read = await ops.call('read', { path: '/vault/key.txt' })
    const listed = await ops.call('ls', { path: '/' })
    const globbed = await ops.call('glob', { pattern: '/*/*.txt' })
    const found = await ops.call('grep', { pattern: 'key', path: '/vault' })
    const shown = await ops.call('read', { path: '/ro/r.txt' })
    const fallback = await guarded.tools.call('read', {
      path: '/vault/key.txt',
    })
    await guarded.close()
    expect(textOf(read)).toBe("Error: file '/vault/key.txt' not found")
    expect(textOf(listed)).not.toContain('vault')
    expect(textOf(globbed)).toBe('/ro/r.txt\n')
    expect(found.isError).toBe(true)
    expect(textOf(shown)).toBe('     1\tr\n')
    expect(textOf(fallback)).toBe('     1\tkey\n')
  })

  it('answers a refused write or edit as a tool error', async () => {
    const guarded = await guardedWs()
    const ops = new Session(guarded, 'agent').tools
    await ops.call('read', { path: '/ro/r.txt' })
    const written = await ops.call('write', { path: '/ro/r.txt', content: 'x' })
    const edited = await ops.call('edit', { path: '/ro/r.txt', old_string: 'r', new_string: 'R' })
    const hidden = await ops.call('write', { path: '/vault/new/n.txt', content: 'x' })
    await guarded.close()
    for (const result of [written, edited, hidden]) {
      expect(result.isError).toBe(true)
      expect(textOf(result)).toMatch(/^Error: /)
    }
  })

  it('keeps a session already bound rather than widening it', async () => {
    const guarded = await guardedWs()
    const wide = guarded.tools
    const read = await runWithSession(guarded.getSession('agent'), () =>
      wide.call('read', { path: '/vault/key.txt' }),
    )
    await guarded.close()
    expect(textOf(read)).toBe("Error: file '/vault/key.txt' not found")
  })

  it('serves a stored session on the first call', async () => {
    const store = new RAMWorkspaceStateStore()
    const ram = new RAMVFS()
    const open = (): Workspace =>
      new Workspace(
        { '/': ram },
        { mode: MountMode.WRITE, workspaceId: 'shared', store, shellParser },
      )
    const writer = open()
    writer.createSession('agent')
    await writer.ensureSessionsLoaded()
    await writer.flushSessions()
    const attached = open()
    try {
      const written = await new Session(attached, 'agent').tools.call('write', {
        path: '/a.txt',
        content: 'x\n',
      })
      expect(textOf(written)).toBe('Written: /a.txt')
    } finally {
      await writer.close()
      await attached.close()
    }
  })
})
