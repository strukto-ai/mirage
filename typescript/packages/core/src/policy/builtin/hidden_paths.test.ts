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
import { runWithSession } from '../../context/session_context.ts'
import { MountMode, PathSpec } from '../../types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { getTestParser } from '../../../tests/workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { SessionState } from '../../workspace/session/session.ts'
import type { Policy } from '../base.ts'
import type { Action, VfsContext } from '../types.ts'
import { HiddenPathsPolicy } from './hidden_paths.ts'
import { CALLS } from '../../workspace/dispatcher/constants.ts'
import type { VfsCall } from '../../vfs/types.ts'

function callOf(name: string): VfsCall {
  const call = CALLS.get(name)
  if (call === undefined) throw new Error(`no call ${name}`)
  return call
}

function ctx(virtual: string, create = false): VfsContext {
  return {
    call: callOf(create ? 'write' : 'read'),
    path: PathSpec.fromStrPath(virtual),
    write: create,
    prefix: '/w/',
  }
}

describe('HiddenPathsPolicy', () => {
  it('a hidden path answers as absent', async () => {
    const sess = new SessionState({
      sessionId: 'agent',
      visibility: { paths: { paths: ['/w/vault'] } },
    })
    await runWithSession(sess, async () => {
      const policy = new HiddenPathsPolicy()
      expect(await policy.preVfs(ctx('/w/open.txt'))).toBeNull()
      const under = await policy.preVfs(ctx('/w/vault/k'))
      expect(under?.kind).toBe('hide')
      expect(under?.error).toMatchObject({ code: 'ENOENT' })
      const named = await policy.preVfs(ctx('/w/vault', true))
      expect(named?.kind).toBe('hide')
      expect(named?.error).toMatchObject({ code: 'EACCES' })
    })
  })

  it('without a session nothing is hidden', async () => {
    expect(await new HiddenPathsPolicy().preVfs(ctx('/w/vault/k'))).toBeNull()
  })

  it('a hide answers before any policy and leaves no record', async () => {
    const sealedReads: Policy = {
      preVfs: (c: VfsContext): Action | null =>
        !c.write && c.path.virtual === '/data/secret' ? { kind: 'deny', reason: 'sealed' } : null,
    }
    const ws = new Workspace(
      { '/data/': new RAMVFS() },
      { mode: MountMode.WRITE, policies: [sealedReads], shellParser: await getTestParser() },
    )
    try {
      await ws.shell('echo s > /data/secret')
      ws.createSession('veiled', { profile: { paths: { hide: ['/data/secret'] } } })
      const hidden: unknown = await ws.vfs
        .read('/data/secret', {}, 'veiled')
        .catch((e: unknown) => e)
      expect((hidden as { code?: string }).code).toBe('ENOENT')
      expect((hidden as { refusal?: unknown }).refusal ?? null).toBeNull()
      const denied: unknown = await ws.vfs.read('/data/secret').catch((e: unknown) => e)
      expect((denied as { refusal?: { reason: string } }).refusal?.reason).toBe('sealed')
    } finally {
      await ws.close()
    }
  })
})
