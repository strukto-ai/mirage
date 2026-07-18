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

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toStateDict } from '@struktoai/mirage-core'
import { MountMode, RAMResource, Workspace } from '@struktoai/mirage-node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commitState } from './api.ts'
import { LocalBackend } from './backend.ts'
import { restore } from './restore.ts'
import { stateDiff } from './stateDiff.ts'
import { VersionStore } from './store.ts'

type AnyDict = Record<string, unknown>

describe('stateDiff + restore', () => {
  let root: string
  let store: VersionStore
  let ws: Workspace
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'mir-sdiff-'))
    store = await VersionStore.open(new LocalBackend(root), 'ws')
    ws = new Workspace({ '/m': new RAMResource() }, { mode: MountMode.EXEC })
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('covers every category', async () => {
    await ws.execute('echo one > /m/a.txt')
    const session = ws.createSession('narrow', { mounts: { '/m': 'read' } })
    session.env.API_KEY = '@aws:prod-key'
    await ws.flushSessions()
    const v1 = await commitState(store, await toStateDict(ws), 'main', 'v1')

    await ws.execute('echo two > /m/a.txt')
    await ws.execute('ln -s /m/a.txt /m/l.txt')
    session.env.API_KEY = '@aws:other-key'
    session.mountModes = new Map([...(session.mountModes ?? []), ['/m', MountMode.WRITE]])
    await ws.flushSessions()
    const v2 = await commitState(store, await toStateDict(ws), 'main', 'v2')

    const diff = await stateDiff(store, v1, v2)

    expect((diff.files as AnyDict).modified).toEqual(['m/a.txt'])
    const changed = ((diff.sessions as AnyDict).modified as AnyDict).narrow as AnyDict
    expect(((changed.env as AnyDict).modified as AnyDict).API_KEY).toEqual({
      from: '@aws:prod-key',
      to: '@aws:other-key',
    })
    expect(((changed.mount_modes as AnyDict).modified as AnyDict)['/m']).toEqual({
      from: 'read',
      to: 'write',
    })
    expect(Object.keys((diff.namespace as AnyDict).added as AnyDict)).toContain('/m/l.txt')
    const commands = (diff.commands as AnyDict[])
      .filter((e) => e.type === 'command')
      .map((e) => e.command)
    expect(commands).toContain('echo two > /m/a.txt')
    expect(commands).not.toContain('echo one > /m/a.txt')
  })

  it('restores a single path, leaving other files and categories alone', async () => {
    await ws.execute('echo one > /m/a.txt')
    await ws.execute('echo keep > /m/b.txt')
    const v1 = await commitState(store, await toStateDict(ws), 'main', 'v1')
    await ws.execute('echo two > /m/a.txt')
    await ws.execute('echo edited > /m/b.txt')

    const report = await restore(store, ws, v1, { paths: ['/m/a.txt'] })

    const a = await ws.execute('cat /m/a.txt')
    const b = await ws.execute('cat /m/b.txt')
    expect(new TextDecoder().decode(a.stdout)).toBe('one\n')
    expect(new TextDecoder().decode(b.stdout)).toBe('edited\n')
    expect(report.categories).toEqual(['files'])
    expect(report.paths).toEqual(['/m/a.txt'])
  })

  it('restores the sessions category only, keeping live files', async () => {
    const session = ws.createSession('narrow', { mounts: { '/m': 'write' } })
    await ws.execute('echo one > /m/a.txt')
    await ws.flushSessions()
    const v1 = await commitState(store, await toStateDict(ws), 'main', 'v1')
    session.mountModes = new Map([...(session.mountModes ?? []), ['/m', MountMode.READ]])
    await ws.execute('echo two > /m/a.txt')
    await ws.flushSessions()

    const report = await restore(store, ws, v1, { categories: ['sessions'] })

    const a = await ws.execute('cat /m/a.txt')
    expect(new TextDecoder().decode(a.stdout)).toBe('two\n')
    expect(ws.getSession('narrow').mountModes?.get('/m')).toBe(MountMode.WRITE)
    expect(report.categories).toEqual(['sessions'])
  })

  it('rejects bad scopes', async () => {
    await ws.execute('echo one > /m/a.txt')
    const v1 = await commitState(store, await toStateDict(ws), 'main', 'v1')
    await expect(
      restore(store, ws, v1, { paths: ['/m/a.txt'], categories: ['files'] }),
    ).rejects.toThrow('not both')
  })
})
