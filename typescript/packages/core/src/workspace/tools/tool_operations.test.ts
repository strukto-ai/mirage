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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Files } from '../files.ts'
import { MountMode } from '../../types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import { Session, Workspace } from '../workspace/workspace.ts'
import { MirageToolOperations, TOOL_NAMES } from './tool_operations.ts'
import { Outcome } from '../../policy/types.ts'
import type { Policy } from '../../policy/base.ts'
import { parseSessionProfile } from '../../policy/profile.ts'
import type { VfsContext } from '../../policy/types.ts'
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

  it('answers a file refused down to its stat as a tool error', async () => {
    await ws.shell('mkdir /d && echo l > /d/locked.txt && echo o > /d/open.txt')
    const lockedFile: Policy = {
      preVfs(ctx: VfsContext) {
        return ctx.path.virtual === '/d/locked.txt' ? { kind: 'deny', reason: 'locked' } : null
      },
    }
    ws.policies.add(lockedFile)
    const read = await ops.call('read', { path: '/d/locked.txt' })
    const written = await ops.call('write', { path: '/d/locked.txt', content: 'x' })
    const edited = await ops.call('edit', {
      path: '/d/locked.txt',
      old_string: 'l',
      new_string: 'm',
    })
    const globbed = await ops.call('glob', { pattern: '/d/*.txt' })
    const literal = await ops.call('glob', { pattern: '/d/locked.txt' })
    for (const result of [read, edited]) {
      expect(result.isError).toBe(true)
      expect(textOf(result)).not.toContain('not found')
    }
    expect(written.isError).toBe(true)
    expect(textOf(written)).toMatch(/^Error: /)
    expect(textOf(globbed)).toBe('/d/open.txt\n')
    expect(textOf(literal)).toBe('')
    expect(literal.isError).not.toBe(true)
  })

  it('answers a probe that fails with the tool error', async () => {
    // A backend that cannot answer the existence probe proves nothing, so
    // the tool reports the failure as its result instead of raising it.
    await ws.shell('mkdir /d')
    const spy = vi
      .spyOn(Files.prototype, 'exists')
      .mockRejectedValue(Object.assign(new Error('Input/output error'), { code: 'EIO' }))
    try {
      const read = await ops.call('read', { path: '/d/flaky.txt' })
      const written = await ops.call('write', { path: '/d/flaky.txt', content: 'x' })
      // The read's own error stands, never the probe's.
      expect(read.isError).toBe(true)
      expect(textOf(read)).toBe('Error: /d/flaky.txt: No such file or directory')
      expect(written.isError).toBe(true)
      expect(textOf(written)).toContain('Input/output error')
    } finally {
      spy.mockRestore()
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

describe('the tool list', () => {
  it.each([
    [null, MountMode.WRITE, TOOL_NAMES],
    [null, MountMode.READ, ['shell', 'read', 'ls', 'grep', 'glob']],
    [{ commands: { allow: ['cat'] } }, MountMode.WRITE, ['shell', 'read', 'write', 'edit', 'glob']],
    [{ commands: { allow: [] } }, MountMode.WRITE, ['read', 'write', 'edit', 'glob']],
    [
      { commands: { deny: [{ reason: 'no', commands: ['grep'] }] } },
      MountMode.WRITE,
      ['shell', 'read', 'write', 'edit', 'ls', 'glob'],
    ],
    [{ mounts: { '/': 'read' } }, MountMode.WRITE, ['shell', 'read', 'ls', 'grep', 'glob']],
    [{ mounts: { '/': 'read' }, paths: { show: { '/out': 'rw' } } }, MountMode.WRITE, TOOL_NAMES],
  ] as const)('follows the profile: %j on %s', (profile, mode, names) => {
    const own = new Workspace({ '/': new RAMVFS() }, { mode, shellParser })
    if (profile !== null) own.createSession('agent', { profile: parseSessionProfile(profile) })
    const session = new Session(own, profile === null ? null : 'agent')
    expect(session.tools.names()).toEqual(names)
  })

  it('a tool the profile does not offer is no tool', async () => {
    const own = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE, shellParser })
    own.createSession('ro', { profile: parseSessionProfile({ mounts: { '/': 'read' } }) })
    await expect(
      new Session(own, 'ro').tools.call('write', { path: '/x', content: 'y' }),
    ).rejects.toThrow(/unknown tool: write/)
  })
})

describe('a path ask outside a line', () => {
  it('waits on the host, runs one call on a nod and asks again', async () => {
    const own = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE, shellParser })
    own.createSession('agent', {
      profile: {
        commands: { ask: [{ reason: 'outbox needs a nod', paths: ['/data/out/*'] }] },
      },
    })
    const tools = new Session(own, 'agent').tools
    const asked = await tools.write('/data/out/a.txt', 'hi')
    expect(asked.isError).toBe(true)
    const [record] = own.decisions.pending('agent')
    expect([record?.command, record?.paths]).toEqual(['', ['/data/out/a.txt']])
    expect(asked.content[0]?.text).toBe(
      `Error: /data/out/a.txt: Permission denied\nrequires approval: outbox needs a nod (ask ${record?.id ?? ''})\n`,
    )
    // Asking again quotes the same question.
    await tools.write('/data/out/a.txt', 'hi')
    expect(own.decisions.pending('agent').map((r) => r.id)).toEqual([record?.id])
    await own.decisions.answer(record?.id ?? '', Outcome.ALLOW)
    expect((await tools.write('/data/out/a.txt', 'hi')).isError).toBeUndefined()
    // The nod was for one call on that path, and it is spent.
    expect((await tools.write('/data/out/a.txt', 'again')).isError).toBe(true)
    // A line holds no question for its ops: the redirect is the line's to
    // ask about, at command admission.
    const io = await own.shell('echo hi > /data/out/b.txt', { sessionId: 'agent' })
    expect(io.exitCode).not.toBe(0)
  })
})
