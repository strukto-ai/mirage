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
import { makeWorkspace, stdoutStr } from '../fixtures/workspace_fixture.ts'

describe('background jobs respect mountModes (regression)', () => {
  // This passes both before and after the Session.fork() migration: the
  // bg-job promise is created inside the parent's runWithSession() scope,
  // so AsyncLocalStorage propagates the *parent* session to
  // assertMountAllowed even though the bgSession object itself does not
  // carry mountModes. Pinning this so a future change to ALS scoping
  // (or a switch from ALS to per-session-object enforcement) cannot
  // silently let `cmd &` escape an allowlist.
  it('cmd & in a restricted session cannot escape the allowlist', async () => {
    const { ws } = await makeWorkspace()
    ws.createSession('restricted', { mounts: ['/disk'] })
    await ws.execute('echo hello > /ram/leaked.txt &', {
      sessionId: 'restricted',
    })
    await ws.execute('wait', { sessionId: 'restricted' })
    // Read back from the DEFAULT (unrestricted) session so we measure
    // whether the bg write actually landed, not whether the read is
    // also blocked.
    const probe = await ws.execute('cat /ram/leaked.txt')
    expect(stdoutStr(probe).includes('hello')).toBe(false)
    await ws.close()
  }, 30_000)
})
