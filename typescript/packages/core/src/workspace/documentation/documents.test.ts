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

import { describe, expect, it, vi } from 'vitest'
import { CLI, CLIHandler } from '../../commands/cli/types.ts'
import { Argument, CommandSpec } from '../../commands/spec/types.ts'
import { ScriptSource } from '../../runtime/types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { parseSessionProfile } from '../../policy/profile.ts'
import { Workspace } from '../workspace/workspace.ts'
import { applyStateDict, toStateDict } from '../snapshot/state.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'

async function workspace(): Promise<Workspace> {
  return new Workspace(
    { '/data': new RAMVFS(), '/secret': new RAMVFS() },
    {
      mode: MountMode.WRITE,
      profiles: { reader: { paths: { hide: ['/secret'] } } },
      shellParser: await getTestParser(),
    },
  )
}

describe('generated documents', () => {
  it.each([
    { script: null, arguments: [], ownsArgv: false },
    { script: null, arguments: [new Argument('--output'), new Argument('PATH')], ownsArgv: false },
    { script: new ScriptSource('1'), arguments: [new Argument('--output')], ownsArgv: false },
    { script: new ScriptSource('1'), arguments: [], ownsArgv: true },
  ])(
    'previews a profile without a session, and renders for each reader ($ownsArgv)',
    async ({ script, arguments: args, ownsArgv }) => {
      const ws = await workspace()
      ws.registerCli(
        'tool',
        new CLI({
          spec: new CommandSpec({ name: 'tool', arguments: args, addHelp: false }),
          script,
          handlers: script ? {} : { '': new CLIHandler({ fn: vi.fn() }) },
        }),
      )
      await ws.session('a', { profile: 'reader' })
      await ws.session('b')
      const preview = await ws.vfsMd(undefined, { profile: 'reader' })
      expect(preview).not.toContain('/secret')
      expect(ws.listSessions()).toHaveLength(3)
      await ws.vfsMd('/VFS.md')
      const [restricted, full] = await Promise.all([
        ws.vfs.cat('/VFS.md', 'a'),
        ws.vfs.cat('/VFS.md', 'b'),
      ])
      expect(restricted).toBe(preview)
      expect(full).toContain('/secret')
      const skill = await ws.skillMd()
      expect(skill).toContain('## `tool`')
      expect(skill.includes('This program parses its own arguments')).toBe(ownsArgv)
      expect(skill.includes('--output OUTPUT')).toBe(args.length > 0)
      expect(ws.listSessions()).toHaveLength(3)
      await ws.close()
    },
  )
  it('checks exact paths, existing parents and collisions without backend writes', async () => {
    const ws = await workspace()
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
    const ws = await workspace()
    const a = await ws.session('a')
    await a.vfsMd('/VFS.md')
    await ws.session('b')
    const [owner, other] = await Promise.all(
      ['a', 'b'].map(async (sessionId) =>
        new TextDecoder().decode((await ws.shell('df', { sessionId })).stdout),
      ),
    )
    expect(owner).toContain(' /VFS.md\n')
    expect(other).not.toContain('/VFS.md')
    await ws.closeSession('a')
    await ws.session('a')
    await expect(ws.vfs.read('/VFS.md', {}, 'a')).rejects.toThrow()
    await ws.close()
  })
})

it('releases document paths after unmount and the last session closes', async () => {
  const ws = await workspace()
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
  const ws = await workspace()
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

it('binds where a read lands when a link sits above the name', async () => {
  const ws = await workspace()
  await ws.vfs.mkdir('/data/guides')
  await ws.vfs.symlink('/guides', '/data/guides')
  const markdown = await ws.vfsMd('/guides/VFS.md')
  expect(await ws.vfs.cat('/guides/VFS.md')).toBe(markdown)
  expect(await ws.vfs.cat('/data/guides/VFS.md')).toBe(markdown)
  await ws.close()
})

it('drops bindings on an in-place load, so the restored file shows', async () => {
  const source = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
  await source.vfs.write('/data/VFS.md', 'restored\n')
  const state = await toStateDict(source)
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
  await ws.vfsMd('/data/VFS.md')
  await applyStateDict(ws, state)
  expect(await ws.vfs.cat('/data/VFS.md')).toBe('restored\n')
  await ws.vfsMd('/VFS.md')
  expect(await ws.vfs.cat('/VFS.md')).toContain('Virtual filesystem')
  await source.close()
  await ws.close()
})

it('leaves bindings out of the snapshot audit', async () => {
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
  const session = await ws.session('a')
  const unbound = (await toStateDict(ws)).live_only_mounts
  await ws.vfsMd('/VFS.md')
  await session.skillMd('/SKILL.md')
  expect((await toStateDict(ws)).live_only_mounts).toEqual(unbound)
  await ws.close()
})
