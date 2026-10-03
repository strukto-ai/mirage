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
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { parseSessionProfile } from '../../policy/profile.ts'
import { Workspace } from '../workspace/workspace.ts'
import { CLISpec } from '../../commands/cli/types.ts'
import { Option, Operand } from '../../commands/spec/types.ts'

function workspace(): Workspace {
  const ws = new Workspace(
    { '/data': new RAMVFS(), '/secret': new RAMVFS() },
    { mode: MountMode.WRITE, profiles: { reader: { paths: { hide: ['/secret'] } } } },
  )
  ws.registerCli(
    'tickets',
    new CLISpec({
      name: 'tickets',
      description: 'Ticket operations',
      subcommands: [
        new CLISpec({
          name: 'list',
          fn: () => null,
          options: [
            new Option({
              long: '--limit',
              type: 'int',
              metavar: 'N',
              default: '20',
              description: 'Maximum rows',
            }),
          ],
        }),
        new CLISpec({
          name: 'delete',
          fn: () => null,
          positional: [new Operand({ name: 'id', type: 'str' })],
        }),
      ],
    }),
  )
  return ws
}

describe('generated documents', () => {
  it('is optional, independent and scoped to a session', async () => {
    const ws = workspace()
    const a = await ws.session('a', { profile: 'reader' })
    const b = await ws.session('b')
    expect(await ws.vfs.readdir('/')).not.toContain('/VFS.md')
    const preview = await ws.vfsMd(undefined, { profile: 'reader' })
    expect(preview).not.toContain('/secret')
    expect(ws.listSessions()).toHaveLength(3)
    await a.vfsMd('/VFS.md')
    expect(await ws.vfs.readdir('/', 'a')).toContain('/VFS.md')
    expect(await ws.vfs.readdir('/', 'b')).not.toContain('/VFS.md')
    await expect(ws.vfs.read('/VFS.md', {}, 'b')).rejects.toThrow()
    expect(await ws.vfs.cat('/VFS.md', 'a')).toBe(preview)
    await b.skillMd('/SKILL.md')
    expect(await ws.vfs.readdir('/', 'a')).not.toContain('/SKILL.md')
    expect(await ws.vfs.cat('/SKILL.md', 'b')).toContain('tickets list')
    await ws.close()
  })
  it('renders global views for the current reader on every read', async () => {
    const ws = workspace()
    await ws.session('a', { profile: 'reader' })
    await ws.session('b')
    await ws.vfsMd('/VFS.md')
    await ws.skillMd('/SKILL.md')
    const [restricted, full] = await Promise.all([
      ws.vfs.cat('/VFS.md', 'a'),
      ws.vfs.cat('/VFS.md', 'b'),
    ])
    expect(restricted).not.toContain('/secret')
    expect(full).toContain('/secret')
    await ws.setSessionProfile('b', 'reader')
    expect(await ws.vfs.cat('/VFS.md', 'b')).toBe(restricted)
    await ws.setSessionProfile('a', { commands: { allow: ['tickets list', 'cat', 'man'] } })
    const skill = await ws.vfs.cat('/SKILL.md', 'a')
    expect(skill).toContain('tickets list')
    expect(skill).not.toContain('tickets delete')
    expect(skill).toContain('--limit N')
    expect(skill).toContain('default: 20')
    expect((await ws.vfs.stat('/SKILL.md', 'a')).size).toBe(new TextEncoder().encode(skill).length)
    await expect(ws.vfs.write('/SKILL.md', 'replacement', 'a')).rejects.toThrow()
    await ws.close()
  })
  it('checks exact paths, existing parents and collisions without backend writes', async () => {
    const ws = workspace()
    await ws.vfs.mkdir('/data/guides')
    await ws.vfs.write('/data/exists', 'keep')
    await expect(ws.vfsMd('/data/exists')).rejects.toThrow()
    await expect(ws.skillMd('/skills/mirage/SKILL.md')).rejects.toThrow()
    for (const path of ['relative', '/', '/data/../VFS.md', '/data//VFS.md'])
      await expect(ws.vfsMd(path)).rejects.toThrow('normalized')
    await expect(ws.vfsMd('/VFS.md', { profile: 'reader' })).rejects.toThrow('profile')
    await expect(ws.vfsMd(undefined, { profile: 'reader', sessionId: 'missing' })).rejects.toThrow(
      'profile',
    )
    await ws.vfsMd('/data/guides/VFS.md')
    await ws.vfsMd('/data/guides/VFS.md')
    await expect(ws.skillMd('/data/guides/VFS.md')).rejects.toThrow()
    expect(await ws.vfs.cat('/data/exists')).toBe('keep')
    const vfs = ws.registry.tryMountForPrefix('/data')?.vfs as RAMVFS
    expect(vfs.store.files.has('/guides/VFS.md')).toBe(false)
    await ws.close()
  })
  it('does not grant an old session view to a reused id', async () => {
    const ws = workspace()
    const a = await ws.session('a')
    await a.vfsMd('/VFS.md')
    await ws.closeSession('a')
    await ws.session('a')
    await expect(ws.vfs.read('/VFS.md', {}, 'a')).rejects.toThrow()
    await ws.close()
  })
})

it('releases document paths after unmount and the last session closes', async () => {
  const ws = workspace()
  const a = await ws.session('a')
  const b = await ws.session('b')
  await a.vfsMd('/guide.md')
  await b.vfsMd('/guide.md')
  await ws.closeSession('a')
  expect(await ws.vfs.cat('/guide.md', 'b')).toContain('Virtual filesystem')
  await ws.closeAllSessions()
  await ws.skillMd('/guide.md')
  await ws.unmount('/guide.md')
  await ws.vfsMd('/guide.md')
  expect(await ws.vfs.cat('/guide.md')).toContain('Virtual filesystem')
  await ws.close()
})

it('omits unrestricted backend guidance with subtree mode overrides', async () => {
  const ws = workspace()
  await ws.setSessionProfile(
    ws.defaultSessionId,
    parseSessionProfile({ paths: { show: { '/data/public': 'r' } } }),
  )
  const markdown = await ws.vfsMd()
  expect(markdown).not.toContain('In-memory')
  expect(markdown).toContain('`/data/public`: read-only')
  await ws.close()
})

it('excludes live documents from a workspace copy', async () => {
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
  await ws.vfsMd('/VFS.md')
  await ws.skillMd('/SKILL.md')
  const clone = await ws.copy()
  expect(await clone.vfs.exists('/VFS.md')).toBe(false)
  expect(await clone.vfs.exists('/SKILL.md')).toBe(false)
  await clone.vfsMd('/VFS.md')
  expect(await clone.vfs.cat('/VFS.md')).toContain('Virtual filesystem')
  await clone.close()
  await ws.close()
})
