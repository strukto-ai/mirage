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
import { buildApp } from '../app.ts'

interface ExplainedLine {
  outcome: string
  exit_code: number
  stderr: string
  refusal: { kind: string } | null
  node: {
    children: {
      type: string
      command: string
      argv: string[]
      answers: { kind: string; reason: string; policy: string }[]
    }[]
  }
}

describe('explain routes', () => {
  it('explain/shell is the dry run of shell', async () => {
    const app = buildApp()
    let r = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: {
        id: 'ex',
        config: {
          mounts: { '/': { vfs: 'ram', mode: 'write' } },
          profiles: {
            guarded: { commands: { ask: [{ commands: ['rm'], reason: 'sign-off' }] } },
          },
        },
      },
    })
    expect(r.statusCode).toBe(201)
    r = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/ex/sessions',
      payload: { session_id: 'agent', profile: 'guarded' },
    })
    expect(r.statusCode).toBe(201)
    r = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/ex/explain/shell',
      payload: { command: 'rm /f.txt', session_id: 'agent' },
    })
    expect(r.statusCode).toBe(200)
    const said = r.json<ExplainedLine>()
    expect([said.outcome, said.exit_code, said.stderr, said.refusal?.kind]).toEqual([
      'ask',
      126,
      'rm: Permission denied\n',
      'pending',
    ])
    const [rm] = said.node.children
    expect([rm?.type, rm?.command, rm?.argv]).toEqual(['command', 'rm', ['/f.txt']])
    expect(rm?.answers).toEqual([{ kind: 'ask', reason: 'sign-off', policy: 'PermissionsPolicy' }])
    r = await app.inject({ method: 'GET', url: '/v1/workspaces/ex/asks' })
    expect(r.json()).toEqual([])
    r = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/ex/explain/shell',
      payload: { command: 'ls', session_id: 'nobody' },
    })
    expect(r.statusCode).toBe(404)
    await app.close()
  })
})
