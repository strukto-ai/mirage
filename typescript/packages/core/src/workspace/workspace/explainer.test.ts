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
import {
  Outcome,
  Scope,
  type CommandContext,
  type Deny,
  type VfsContext,
  type Policy,
} from '../../policy/index.ts'
import { parseSessionProfile } from '../../policy/profile.ts'
import { MountMode } from '../../types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import type { DriftQueue } from '../snapshot/drift.ts'
import { Session, Workspace } from './workspace.ts'

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

  it('leaves the drift checks pending', async () => {
    const drift = (ws as unknown as { drift: DriftQueue }).drift
    drift.queue('/data/sec/k', 'fingerprint')
    await new Session(ws, 'agent').explain.vfs.read('/data/sec/k')
    expect(drift.pending).toBe(true)
  })

  it('lets a policy read for real while it decides', async () => {
    await ws.vfs.write('/data/flag', 'closed')
    const flagged: Policy = {
      async preVfs(ctx: VfsContext): Promise<Deny | null> {
        if (ctx.op !== 'write' || ctx.path.virtual === '/data/flag') return null
        const flag = new TextDecoder().decode(await ws.vfs.read('/data/flag'))
        return flag === 'closed' ? { kind: 'deny', reason: 'closed' } : null
      },
    }
    ws.policies.add(flagged)
    const said = await new Session(ws, 'agent').explain.vfs.write('/data/new', 'x')
    expect([said.reason, said.answers.map((a) => a.reason)]).toEqual(['closed', ['closed']])
  })

  /**
   * Deciding a write to `/data/new`, or the line `ls /data/new`, reads an
   * asked file as the agent and stamps one; `errors` collects the codes.
   */
  function busy(errors: (string | undefined)[]): Policy {
    const failed = (err: unknown): void => {
      errors.push((err as { code?: string }).code)
    }
    const work = async (): Promise<null> => {
      await new Session(ws, 'agent').vfs.read('/data/out/q').catch(failed)
      await ws.vfs.write('/data/stamp', 'seen').catch(failed)
      return null
    }
    return {
      async preVfs(ctx: VfsContext): Promise<null> {
        return ctx.op === 'write' && ctx.path.virtual === '/data/new' ? work() : null
      },
      async preCommand(ctx: CommandContext): Promise<null> {
        return ctx.command === 'ls' ? work() : null
      },
    }
  }

  it('lets a policy change nothing while it decides', async () => {
    const errors: (string | undefined)[] = []
    ws.policies.add(busy(errors))
    await new Session(ws, 'agent').explain.vfs.write('/data/new', 'x')
    expect(errors).toEqual(['EACCES', 'EROFS'])
    expect(ws.decisions.pending('agent')).toEqual([])
    expect(await ws.vfs.exists('/data/stamp')).toBe(false)
  })

  it('lets a line’s policies change nothing either', async () => {
    const errors: (string | undefined)[] = []
    ws.policies.add(busy(errors))
    await new Session(ws, 'agent').explain.shell('ls /data/new')
    expect(errors).toEqual(['EACCES', 'EROFS'])
    expect(ws.decisions.pending('agent')).toEqual([])
    expect(await ws.vfs.exists('/data/stamp')).toBe(false)
  })

  it('lets a standing approval cover a deciding read', async () => {
    await ws.vfs.mkdir('/data/out')
    await ws.vfs.write('/data/out/q', 'q')
    await expect(new Session(ws, 'agent').vfs.read('/data/out/q')).rejects.toThrow()
    const [asked] = ws.decisions.pending('agent')
    await ws.decisions.answer(asked?.id ?? '', Outcome.ALLOW, Scope.SESSION)
    const errors: (string | undefined)[] = []
    ws.policies.add(busy(errors))
    await new Session(ws, 'agent').explain.vfs.write('/data/new', 'x')
    expect(errors).toEqual(['EROFS'])
  })

  it('reads a line’s policy as the running line does', async () => {
    await ws.vfs.mkdir('/data/out')
    await ws.vfs.write('/data/out/q', 'q')
    await expect(new Session(ws, 'agent').vfs.read('/data/out/q')).rejects.toThrow()
    const [asked] = ws.decisions.pending('agent')
    await ws.decisions.answer(asked?.id ?? '', Outcome.ALLOW, Scope.SESSION)
    const errors: (string | undefined)[] = []
    ws.policies.add(busy(errors))
    // Inside a line an ask refuses like a deny, approved or not.
    await new Session(ws, 'agent').shell('ls /data/new')
    expect(new Set(errors)).toEqual(new Set(['EACCES']))
    errors.length = 0
    await ws.vfs.unlink('/data/stamp')
    await new Session(ws, 'agent').explain.shell('ls /data/new')
    expect(errors).toEqual(['EACCES', 'EROFS'])
  })
})
