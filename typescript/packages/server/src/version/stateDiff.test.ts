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
import { PolicyDenied } from '@struktoai/mirage-core/policy/errors'
import type { Policy } from '@struktoai/mirage-core/policy/index'
import type { Action, SessionContext } from '@struktoai/mirage-core/policy/types'
import { toStateDict } from '@struktoai/mirage-core/workspace/snapshot/state'
import { seedVar } from '@struktoai/mirage-core/workspace/session/state'
import { RAMResource } from '@struktoai/mirage-core/resource/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import { parseSessionProfile } from '@struktoai/mirage-core/policy/profile'
import { Workspace } from '@struktoai/mirage-node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commitState } from './api.ts'
import { LocalBackend } from './backend.ts'
import { restore } from './restore.ts'
import { stateDiff } from './stateDiff.ts'
import { VersionStore } from './store.ts'

type AnyDict = Record<string, unknown>

/** Refuse env writes to GATE_* names, the deployment's rule. */
class DenyGate implements Policy {
  preSession(ctx: SessionContext): Action | null {
    if (ctx.plane === 'env' && ctx.key.startsWith('GATE_')) {
      return { kind: 'deny', reason: 'GATE_* refused by policy' }
    }
    return null
  }
}

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
    seedVar(session, 'API_KEY', '@aws:prod-key')
    await ws.flushSessions()
    const v1 = await commitState(store, await toStateDict(ws), 'main', 'v1')

    await ws.execute('echo two > /m/a.txt')
    await ws.execute('ln -s /m/a.txt /m/l.txt')
    seedVar(session, 'API_KEY', '@aws:other-key')
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

  // A restore lands the whole session table, so a version that differs
  // only in a field the diff never named read as unmodified right up to
  // the checkout that changed the session's access rules.
  it('reports a field beyond env, grants and cwd', async () => {
    const session = ws.createSession('narrow', { mounts: { '/m': 'read' } })
    await ws.flushSessions()
    const v1 = await commitState(store, await toStateDict(ws), 'main', 'v1')

    session.hiddenPaths = { paths: ['/m/secret'], patterns: [] }
    await ws.flushSessions()
    const v2 = await commitState(store, await toStateDict(ws), 'main', 'v2')

    const diff = await stateDiff(store, v1, v2)
    const modified = (diff.sessions as AnyDict).modified as AnyDict
    expect(Object.keys(modified)).toContain('narrow')
    expect(Object.keys(modified.narrow as AnyDict)).toContain('hidden_paths')
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

  // A checkout used to re-apply a version's grants like any other state,
  // so a session the host had narrowed since the commit woke wider than
  // the host left it. A restored table now lands under the live session
  // and never wider than it: the version's restrictions join the live
  // ones, and `setSessionProfile` is the host's reset.
  it('restores the sessions category only, keeping live files, never widening', async () => {
    ws.createSession('narrow', { mounts: { '/m': 'write' } })
    await ws.execute('echo one > /m/a.txt')
    await ws.flushSessions()
    const v1 = await commitState(store, await toStateDict(ws), 'main', 'v1')
    await ws.setSessionProfile('narrow', parseSessionProfile({ mounts: { '/m': 'read' } }))
    await ws.execute('echo two > /m/a.txt')
    await ws.flushSessions()

    const report = await restore(store, ws, v1, { categories: ['sessions'] })

    const a = await ws.execute('cat /m/a.txt')
    expect(new TextDecoder().decode(a.stdout)).toBe('two\n')
    expect(ws.getSession('narrow').mountModes?.get('/m')).toBe(MountMode.READ)
    expect(report.categories).toEqual(['sessions'])
    const refused = await ws.execute('echo three > /m/a.txt', { sessionId: 'narrow' })
    expect(refused.exitCode).not.toBe(0)
    await ws.setSessionProfile('narrow', parseSessionProfile({ mounts: { '/m': 'write' } }))
    const allowed = await ws.execute('echo three > /m/a.txt', { sessionId: 'narrow' })
    expect(allowed.exitCode).toBe(0)
  })

  // The version's own narrowing does land: a session narrower at the
  // commit than it is live comes back narrower.
  it("lands a version's restrictions on a live session", async () => {
    ws.createSession('narrow', { mounts: { '/m': 'read' } })
    await ws.flushSessions()
    const v1 = await commitState(store, await toStateDict(ws), 'main', 'v1')
    await ws.setSessionProfile('narrow', parseSessionProfile({ mounts: { '/m': 'write' } }))
    expect((await ws.execute('echo two > /m/a.txt', { sessionId: 'narrow' })).exitCode).toBe(0)
    await ws.flushSessions()

    await restore(store, ws, v1)

    expect(ws.getSession('narrow').mountModes?.get('/m')).toBe(MountMode.READ)
    expect((await ws.execute('echo three > /m/a.txt', { sessionId: 'narrow' })).exitCode).not.toBe(
      0,
    )
  })

  // A checkout lands the whole table (hides, rules, standing
  // decisions, the profile name), so a diff reading only env, grants
  // and cwd called a session unmodified right before a checkout
  // changed what it may do.
  it('reports every restored session field', async () => {
    ws.createSession('narrow', {
      permissions: parseSessionProfile({
        commands: { deny: [{ reason: 'sealed', commands: { cat: ['/m/vault/*'] } }] },
        paths: { hide: ['/m/secret'] },
      }),
    })
    await ws.flushSessions()
    const v1 = await commitState(store, await toStateDict(ws), 'main', 'v1')
    await ws.setSessionProfile(
      'narrow',
      parseSessionProfile({ paths: { hide: ['/m/secret', '/m/keys'] } }),
    )
    await ws.flushSessions()
    const v2 = await commitState(store, await toStateDict(ws), 'main', 'v2')

    const diff = await stateDiff(store, v1, v2)
    const delta = ((diff.sessions as AnyDict).modified as AnyDict).narrow as AnyDict

    // A dict-shaped field reports which of its keys moved.
    const moved = ((delta.hidden_paths as AnyDict).modified as AnyDict).paths as AnyDict
    expect(moved.from).toEqual(['/m/secret'])
    expect([...(moved.to as string[])].sort()).toEqual(['/m/keys', '/m/secret'])
    // The later table carries no rules block at all, so every key of
    // the earlier one reads as deleted.
    const gone = (delta.commands as AnyDict).deleted as AnyDict
    expect((gone.deny as AnyDict[]).map((r) => r.reason)).toEqual(['sealed'])
    // Bookkeeping is not a change: the generation moved with every
    // flush and the id keys the tables.
    for (const key of ['generation', 'created_at', 'session_id'])
      expect(delta).not.toHaveProperty(key)
  })

  it('rejects bad scopes', async () => {
    await ws.execute('echo one > /m/a.txt')
    const v1 = await commitState(store, await toStateDict(ws), 'main', 'v1')
    await expect(
      restore(store, ws, v1, { paths: ['/m/a.txt'], categories: ['files'] }),
    ).rejects.toThrow('not both')
  })

  // The live cache was cleared ahead of the restore's gate, so a refused
  // restore still sent every cached read back to its origin while the
  // rest of the workspace stayed as it was; the clear now sits behind it.
  it('a refused restore leaves the live cache alone', async () => {
    seedVar(ws.createSession('s2'), 'GATE_X', '1')
    const v1 = await commitState(store, await toStateDict(ws), 'main', 'v1')
    await ws.cache.set('k', new TextEncoder().encode('cached'))
    ws.policies.add(new DenyGate())
    await expect(restore(store, ws, v1)).rejects.toBeInstanceOf(PolicyDenied)
    expect(await ws.cache.get('k')).toEqual(new TextEncoder().encode('cached'))
  })
})
