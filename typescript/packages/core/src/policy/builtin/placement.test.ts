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
import type { RouteContext, RoutePolicy } from '../../runtime/routing/types.ts'
import { PlacementPolicy } from './placement.ts'

function line(text: string): RouteContext {
  return {
    line: text,
    commands: [],
    command: text.split(' ')[0] ?? '',
    builtin: false,
    cwd: '/',
    env: {},
    sessionId: '',
    agentId: '',
    mounts: [],
  }
}

describe('PlacementPolicy', () => {
  it('a route verdict is a placement answer', async () => {
    const policy = new PlacementPolicy((ctx) => {
      if (ctx.line.includes('heavy')) return 'beta'
      if (ctx.line.includes('secret')) return { deny: 'secrets stay put' }
      return null
    }, [])
    expect(await policy.preExecute(line('python3 heavy'))).toEqual({
      kind: 'route',
      runtime: 'beta',
    })
    expect(await policy.preExecute(line('cat secret'))).toEqual({
      kind: 'deny',
      reason: 'secrets stay put',
    })
    expect(await policy.preExecute(line('echo hi'))).toBeNull()
    // A mistake in the route policy is the deployment's, not a refusal.
    await expect(
      new PlacementPolicy((() => ({ runtme: 'x' })) as unknown as RoutePolicy, []).preExecute(
        line('echo hi'),
      ),
    ).rejects.toThrow(/unknown policy verdict keys/)
  })
})
