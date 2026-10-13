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
import type { RoutePolicy } from '../../runtime/routing/types.ts'
import { ScriptSource } from '../../runtime/types.ts'
import { ScriptPolicy } from '../script.ts'
import type { RouteContext } from '../types.ts'
import { PlacementPolicy } from './placement.ts'

function line(text: string): RouteContext {
  return { line: text, commands: [], sessionId: '' }
}

function placement(route: RoutePolicy): PlacementPolicy {
  return new PlacementPolicy(route, new ScriptPolicy({ scriptsOf: () => ({}) }))
}

const ROUTE_HEAVY = [
  'import json',
  'import os',
  '',
  'ctx = json.loads(os.environ["MIRAGE_POLICY_CTX"])',
  'if "heavy" in ctx["line"]:',
  '    print(json.dumps({"kind": "route", "runtime": "beta"}))',
  '',
].join('\n')

describe('PlacementPolicy', () => {
  it('places the line on a runtime name and says nothing on null', async () => {
    const policy = placement((ctx) => (ctx.line.includes('heavy') ? 'beta' : null))
    expect(await policy.preExecute(line('python3 heavy'))).toEqual({
      kind: 'route',
      runtime: 'beta',
    })
    expect(await policy.preExecute(line('echo hi'))).toBeNull()
  })

  it.each([
    '',
    { route: 'beta' },
    { deny: 'no' },
    { kind: 'route', runtime: 'beta' },
    { kind: 'deny', reason: 'no' },
    42,
  ])("treats anything but a name or null as the deployment's mistake: %j", async (verdict) => {
    // Refusing a line is a policy's answer, not the router's; a route
    // policy that answers anything else is misconfigured, not a refusal.
    await expect(
      placement((() => verdict) as unknown as RoutePolicy).preExecute(line('echo hi')),
    ).rejects.toThrow(/a runtime name or None/)
  })

  it('runs a program that prints its route or nothing', async () => {
    const policy = placement({ script: new ScriptSource(ROUTE_HEAVY, 'python'), runtime: 'monty' })
    expect(await policy.preExecute(line('python3 heavy'))).toEqual({
      kind: 'route',
      runtime: 'beta',
    })
    expect(await policy.preExecute(line('echo hi'))).toBeNull()
  })

  it.each([
    ['1 / 0', /route_policy exited 1/],
    ["print('beta')", /route_policy must print a JSON answer/],
  ])("treats a failing program as the deployment's mistake: %s", async (source, refusal) => {
    const policy = placement({ script: new ScriptSource(source, 'python'), runtime: 'monty' })
    await expect(policy.preExecute(line('echo hi'))).rejects.toThrow(refusal)
  })

  it('leaves a path to the workspace yaml', () => {
    expect(() => placement('route.py' as unknown as RoutePolicy)).toThrow(
      /a path is the workspace yaml's/,
    )
    expect(() => placement({ script: 'route.py', runtime: 'monty' })).toThrow(
      /routePolicy names a policy by path/,
    )
    expect(() =>
      placement({ script: new ScriptSource('pass', 'python') } as unknown as RoutePolicy),
    ).toThrow(/runtime/)
  })
})
