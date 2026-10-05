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
import { PathSpec } from '../../types.ts'
import { SessionState } from '../../workspace/session/session.ts'
import type { OpsContext } from '../types.ts'
import { HiddenPathsPolicy } from './hidden_paths.ts'

function ctx(virtual: string, create = false): OpsContext {
  return {
    op: create ? 'write' : 'read',
    path: PathSpec.fromStrPath(virtual),
    write: create,
    prefix: '/w/',
    create,
  }
}

describe('HiddenPathsPolicy', () => {
  it('a hidden path answers as absent', async () => {
    const sess = new SessionState({ sessionId: 'agent', hiddenPaths: { paths: ['/w/vault'] } })
    await runWithSession(sess, () => {
      const policy = new HiddenPathsPolicy()
      expect(policy.preOps(ctx('/w/open.txt'))).toBeNull()
      expect(policy.preOps(ctx('/w/vault/k'))?.error).toMatchObject({ code: 'ENOENT' })
      expect(policy.preOps(ctx('/w/vault', true))?.error).toMatchObject({ code: 'EACCES' })
      return Promise.resolve()
    })
  })

  it('without a session nothing is hidden', () => {
    expect(new HiddenPathsPolicy().preOps(ctx('/w/vault/k'))).toBeNull()
  })
})
