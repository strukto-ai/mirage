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
import {
  checkout,
  commitState,
  createBranch,
  diffLiveVsRef,
  statusState,
  versionDiff,
  versionLog,
} from './api.ts'
import { LocalBackend } from './backend.ts'
import { NoSuchBranchError } from './errors.ts'
import { VersionStore } from './store.ts'

function newWs(): Workspace {
  return new Workspace({ '/m': new RAMResource() }, { mode: MountMode.WRITE })
}

describe('version api', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mir-api-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  async function openStore(): Promise<VersionStore> {
    return VersionStore.open(new LocalBackend(root), 'ws')
  }

  it('commits and lists versions newest-first', async () => {
    const ws = newWs()
    const store = await openStore()
    await ws.execute('echo one > /m/a.txt')
    await commitState(store, await toStateDict(ws), 'main', 'first')
    await ws.execute('echo two > /m/a.txt')
    await commitState(store, await toStateDict(ws), 'main', 'second')
    expect((await versionLog(store, 'main')).map((e) => e.message)).toEqual(['second', 'first'])
  })

  it('diffs two versions, reporting changed files only', async () => {
    const ws = newWs()
    const store = await openStore()
    await ws.execute('echo one > /m/a.txt')
    const c1 = await commitState(store, await toStateDict(ws), 'main', 'first')
    await ws.execute('echo two > /m/a.txt')
    await ws.execute('echo new > /m/b.txt')
    const c2 = await commitState(store, await toStateDict(ws), 'main', 'second')
    const diff = await versionDiff(store, c1, c2)
    expect(diff.modified).toEqual(['m/a.txt'])
    expect(diff.added).toEqual(['m/b.txt'])
  })

  it('diffs live state against a ref', async () => {
    const ws = newWs()
    const store = await openStore()
    await ws.execute('echo one > /m/a.txt')
    const c1 = await commitState(store, await toStateDict(ws), 'main', 'first')
    await ws.execute('echo two > /m/a.txt')
    const diff = await diffLiveVsRef(store, await toStateDict(ws), c1)
    expect(diff.modified).toEqual(['m/a.txt'])
  })

  it('status lists everything as added before the first commit', async () => {
    const ws = newWs()
    const store = await openStore()
    await ws.execute('echo one > /m/a.txt')
    const st = await statusState(store, await toStateDict(ws), 'main')
    expect(st).toEqual({ added: ['m/a.txt'], modified: [], deleted: [] })
  })

  it('rejects committing to a branch that does not exist (git-literal)', async () => {
    const ws = newWs()
    const store = await openStore()
    await ws.execute('echo one > /m/a.txt')
    await commitState(store, await toStateDict(ws), 'main', 'first')
    await expect(commitState(store, await toStateDict(ws), 'exp', 'oops')).rejects.toThrow(
      NoSuchBranchError,
    )
  })

  it('diverges on a branch created from main', async () => {
    const ws = newWs()
    const store = await openStore()
    await ws.execute('echo one > /m/a.txt')
    const mainHead = await commitState(store, await toStateDict(ws), 'main', 'first')
    await createBranch(store, 'exp', 'main')
    await ws.execute('echo two > /m/a.txt')
    const expHead = await commitState(store, await toStateDict(ws), 'exp', 'on exp')
    expect((await store.readCommit(expHead)).parents).toEqual([mainHead])
    expect(await store.head('main')).toBe(mainHead)
  })

  it('checks out a version in place', async () => {
    const ws = newWs()
    const store = await openStore()
    await ws.execute('echo original > /m/a.txt')
    const c1 = await commitState(store, await toStateDict(ws), 'main', 'first')
    await ws.execute('echo mutated > /m/a.txt')
    await checkout(store, ws, c1)
    const r = await ws.execute('cat /m/a.txt')
    expect(new TextDecoder().decode(r.stdout)).toBe('original\n')
    expect(await statusState(store, await toStateDict(ws), 'main')).toEqual({
      added: [],
      modified: [],
      deleted: [],
    })
  })

  it('checkout restores the whole world: sessions, symlinks, history', async () => {
    const ws = new Workspace({ '/m': new RAMResource() }, { mode: MountMode.EXEC })
    const store = await openStore()
    await ws.execute('echo original > /m/a.txt')
    await ws.execute('ln -s /m/a.txt /m/l.txt')
    const narrow = ws.createSession('narrow', { mounts: { '/m': 'read' } })
    narrow.env.API_KEY = '@aws:prod-key'
    await ws.flushSessions()
    await commitState(store, await toStateDict(ws), 'main', 'v1')

    await ws.execute('echo mutated > /m/a.txt')
    await ws.execute('rm /m/l.txt')
    narrow.env.API_KEY = '@aws:other-key'
    narrow.mountModes = new Map([['/m', MountMode.WRITE]])

    await checkout(store, ws, 'main')

    const file = await ws.execute('cat /m/a.txt')
    expect(new TextDecoder().decode(file.stdout)).toBe('original\n')
    const link = await ws.execute('readlink /m/l.txt')
    expect(new TextDecoder().decode(link.stdout).trim()).toBe('/m/a.txt')
    const restored = ws.getSession('narrow')
    expect(restored.env.API_KEY).toBe('@aws:prod-key')
    expect(restored.mountModes?.get('/m')).toBe(MountMode.READ)
    const history = await ws.execute('history')
    const historyText = new TextDecoder().decode(history.stdout)
    expect(historyText).toContain('echo original > /m/a.txt')
    expect(historyText).not.toContain('echo mutated > /m/a.txt')
  })
})
