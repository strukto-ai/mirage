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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Outcome, type Deny, type OpsContext, type Policy } from '../../policy/index.ts'
import { parseSessionProfile } from '../../policy/profile.ts'
import { MountMode } from '../../types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import type { DriftQueue } from '../snapshot/drift.ts'
import { Session } from './handle.ts'
import { Workspace } from './workspace.ts'

const PROFILE = {
  mounts: { '/data': 'write', '/ro': 'read' },
  paths: { hide: ['/data/vault'] },
  commands: {
    deny: [{ reason: 'sealed', paths: ['/data/sec/*'] }],
    ask: [{ reason: 'nod', paths: ['/data/out/*'] }],
  },
}

describe('session.explain.vfs', () => {
  let ws: Workspace

  beforeEach(async () => {
    ws = new Workspace(
      { '/data/': new RAMVFS(), '/ro/': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: await getTestParser() },
    )
    await ws.vfs.mkdir('/data/sec')
    await ws.vfs.write('/data/sec/k', 'key')
    await ws.vfs.symlink('/data/link', '/data/sec/k')
    ws.createSession('agent', { profile: parseSessionProfile(PROFILE) })
  })

  afterEach(async () => {
    await ws.close()
  })

  it('explains each op as the door answers', async () => {
    const explain = new Session(ws, 'agent').explain
    const sealed = await explain.vfs.read('/data/sec/k')
    expect([sealed.command, sealed.outcome, sealed.error]).toEqual(['read', Outcome.DENY, 'EACCES'])
    expect(sealed.refusal?.reason).toBe('sealed')
    expect(sealed.answers).toEqual([
      { kind: 'deny', reason: 'sealed', policy: 'PermissionsPolicy' },
    ])
    const asked = await explain.vfs.write('/data/out/a', 'x')
    expect([asked.outcome, asked.error, asked.refusal?.kind]).toEqual([
      Outcome.ASK,
      'EACCES',
      'pending',
    ])
    expect(ws.decisions.pending('agent')).toEqual([])
    // The mode throws its own error, so no record rides it.
    const readOnly = await explain.vfs.mkdir('/ro/d')
    expect([readOnly.error, readOnly.refusal]).toEqual(['EROFS', null])
    expect(readOnly.answers.at(-1)?.policy).toBe('MountModePolicy')
    const free = await explain.vfs.write('/data/new', 'x')
    expect([free.outcome, free.error, free.answers]).toEqual([Outcome.ALLOW, '', []])
    // Nothing ran.
    expect(await ws.vfs.exists('/data/new')).toBe(false)
  })

  it('follows the door’s own path', async () => {
    const explain = new Session(ws, 'agent').explain
    const linked = await explain.vfs.read('/data/link')
    expect([linked.argv, linked.error, linked.refusal?.reason]).toEqual([
      ['/data/link'],
      'EACCES',
      'sealed',
    ])
    const moved = await explain.vfs.rename('/data/a', '/data/sec/b')
    expect([moved.argv, moved.error, moved.refusal?.reason]).toEqual([
      ['/data/a', '/data/sec/b'],
      'EACCES',
      'sealed',
    ])
  })

  it('explains a hidden path like one nothing refuses', async () => {
    const explain = new Session(ws, 'agent').explain
    const hidden = await explain.vfs.read('/data/vault/k')
    const missing = await explain.vfs.read('/data/nothing')
    expect(hidden).toEqual({ ...missing, argv: ['/data/vault/k'] })
    expect([missing.outcome, missing.error]).toEqual([Outcome.ALLOW, ''])
    const exists = await explain.vfs.exists('/data/nothing')
    expect([exists.command, exists.argv]).toEqual(['exists', ['/data/nothing']])
  })

  it('leaves the drift checks pending', async () => {
    const drift = (ws as unknown as { drift: DriftQueue }).drift
    drift.queue('/data/sec/k', 'fingerprint')
    await new Session(ws, 'agent').explain.vfs.read('/data/sec/k')
    expect(drift.pending).toBe(true)
  })

  it('lets a policy read for real while it decides', async () => {
    await ws.vfs.write('/data/flag', 'closed')
    const flagged: Policy = {
      async preOps(ctx: OpsContext): Promise<Deny | null> {
        if (ctx.op !== 'write' || ctx.path.virtual === '/data/flag') return null
        const flag = new TextDecoder().decode(await ws.vfs.read('/data/flag'))
        return flag === 'closed' ? { kind: 'deny', reason: 'closed' } : null
      },
    }
    ws.policies.add(flagged)
    const said = await new Session(ws, 'agent').explain.vfs.write('/data/new', 'x')
    expect([said.reason, said.answers.map((a) => a.reason)]).toEqual(['closed', ['closed']])
  })

  it('lets a policy change nothing while it decides', async () => {
    const errors: (string | undefined)[] = []
    const failed = (err: unknown): void => {
      errors.push((err as { code?: string }).code)
    }
    const busy: Policy = {
      async preOps(ctx: OpsContext): Promise<null> {
        if (ctx.op !== 'write' || ctx.path.virtual !== '/data/new') return null
        await new Session(ws, 'agent').vfs.read('/data/out/q').catch(failed)
        await ws.vfs.write('/data/stamp', 'seen').catch(failed)
        return null
      },
    }
    ws.policies.add(busy)
    await new Session(ws, 'agent').explain.vfs.write('/data/new', 'x')
    expect(errors).toEqual(['EACCES', 'EROFS'])
    expect(ws.decisions.pending('agent')).toEqual([])
    expect(await ws.vfs.exists('/data/stamp')).toBe(false)
  })
})
