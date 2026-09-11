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

const ASK_REASON = 'removal needs sign-off'

interface AskRow {
  id: string
  sessionId: string
  command: string
  argv: string[]
  reason: string
  outcome: string | null
  scope: string
  note: string
}

async function createWs(app: ReturnType<typeof buildApp>, id: string): Promise<void> {
  const r = await app.inject({
    method: 'POST',
    url: '/v1/workspaces',
    payload: {
      id,
      config: {
        mounts: { '/': { resource: 'ram', mode: 'write' } },
        profiles: {
          guarded: { commands: { ask: [{ commands: ['rm'], reason: ASK_REASON }] } },
        },
      },
    },
  })
  expect(r.statusCode).toBe(201)
}

async function createSession(
  app: ReturnType<typeof buildApp>,
  wsId: string,
  sessionId: string,
): Promise<void> {
  const r = await app.inject({
    method: 'POST',
    url: `/v1/workspaces/${wsId}/sessions`,
    payload: { sessionId, profile: 'guarded' },
  })
  expect(r.statusCode).toBe(201)
}

async function execute(
  app: ReturnType<typeof buildApp>,
  wsId: string,
  sessionId: string,
  command: string,
): Promise<{ exitCode: number; stderr: string; refusal: { kind: string; reason: string } | null }> {
  const r = await app.inject({
    method: 'POST',
    url: `/v1/workspaces/${wsId}/execute`,
    payload: { command, sessionId },
  })
  expect(r.statusCode).toBe(200)
  return r.json<{
    exitCode: number
    stderr: string
    refusal: { kind: string; reason: string } | null
  }>()
}

async function raiseAsk(
  app: ReturnType<typeof buildApp>,
  wsId: string,
  sessionId: string,
): Promise<string> {
  const refused = await execute(app, wsId, sessionId, 'rm /f.txt')
  expect(refused.exitCode).toBe(126)
  expect(refused.stderr).toBe('rm: Permission denied\n')
  expect(refused.refusal?.kind).toBe('pending')
  const r = await app.inject({
    method: 'GET',
    url: `/v1/workspaces/${wsId}/asks?sessionId=${sessionId}`,
  })
  expect(r.statusCode).toBe(200)
  const pending = r.json<AskRow[]>()
  expect(pending).toHaveLength(1)
  const first = pending[0]
  if (first === undefined) throw new Error('no pending ask')
  return first.id
}

describe('asks router', () => {
  it('lists the pending ask, allow passes the retry, once is consumed', async () => {
    const app = buildApp()
    await createWs(app, 'asks-allow')
    await createSession(app, 'asks-allow', 'agent_a')
    await execute(app, 'asks-allow', 'agent_a', 'touch /f.txt')
    const askId = await raiseAsk(app, 'asks-allow', 'agent_a')

    const list = await app.inject({ method: 'GET', url: '/v1/workspaces/asks-allow/asks' })
    const rows = list.json<AskRow[]>()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: askId,
      sessionId: 'agent_a',
      command: 'rm',
      argv: ['/f.txt'],
      reason: ASK_REASON,
      outcome: null,
    })

    const answered = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/asks-allow/asks/${askId}`,
      payload: { answer: 'allow', note: 'reviewed' },
    })
    expect(answered.statusCode).toBe(200)
    expect(answered.json<AskRow>()).toMatchObject({
      id: askId,
      outcome: 'allow',
      scope: 'once',
      note: 'reviewed',
    })

    const pendingAfter = await app.inject({ method: 'GET', url: '/v1/workspaces/asks-allow/asks' })
    expect(pendingAfter.json<AskRow[]>()).toHaveLength(0)
    const allAfter = await app.inject({
      method: 'GET',
      url: '/v1/workspaces/asks-allow/asks?all=true',
    })
    expect(allAfter.json<AskRow[]>().map((a) => a.id)).toEqual([askId])

    const retried = await execute(app, 'asks-allow', 'agent_a', 'rm /f.txt')
    expect(retried.exitCode).toBe(0)
    // The ONCE answer is consumed by the retry that used it.
    const spent = await app.inject({
      method: 'GET',
      url: '/v1/workspaces/asks-allow/asks?all=true',
    })
    expect(spent.json<AskRow[]>()).toHaveLength(0)
    await app.close()
  })

  it('deny refuses the retry in the deny voice', async () => {
    const app = buildApp()
    await createWs(app, 'asks-deny')
    await createSession(app, 'asks-deny', 'agent_a')
    const askId = await raiseAsk(app, 'asks-deny', 'agent_a')

    const answered = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/asks-deny/asks/${askId}`,
      payload: { answer: 'deny' },
    })
    expect(answered.statusCode).toBe(200)
    expect(answered.json<AskRow>().outcome).toBe('deny')

    const retried = await execute(app, 'asks-deny', 'agent_a', 'rm /f.txt')
    expect(retried.exitCode).toBe(126)
    expect(retried.stderr).toBe('rm: Permission denied\n')
    expect(retried.refusal?.kind).toBe('deny')
    expect(retried.refusal?.reason).toContain(ASK_REASON)
    await app.close()
  })

  it('a session-scoped allow covers the next matching line', async () => {
    const app = buildApp()
    await createWs(app, 'asks-scope')
    await createSession(app, 'asks-scope', 'agent_a')
    await execute(app, 'asks-scope', 'agent_a', 'touch /f.txt /g.txt')
    const askId = await raiseAsk(app, 'asks-scope', 'agent_a')

    const answered = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/asks-scope/asks/${askId}`,
      payload: { answer: 'allow', scope: 'session' },
    })
    expect(answered.statusCode).toBe(200)
    expect(answered.json<AskRow>().scope).toBe('session')

    for (const target of ['/f.txt', '/g.txt']) {
      const retried = await execute(app, 'asks-scope', 'agent_a', `rm ${target}`)
      expect(retried.exitCode).toBe(0)
    }
    await app.close()
  })

  it('filters the listing by session', async () => {
    const app = buildApp()
    await createWs(app, 'asks-filter')
    await createSession(app, 'asks-filter', 'agent_a')
    await createSession(app, 'asks-filter', 'agent_b')
    await raiseAsk(app, 'asks-filter', 'agent_a')
    await raiseAsk(app, 'asks-filter', 'agent_b')

    const all = await app.inject({ method: 'GET', url: '/v1/workspaces/asks-filter/asks' })
    expect(new Set(all.json<AskRow[]>().map((a) => a.sessionId))).toEqual(
      new Set(['agent_a', 'agent_b']),
    )
    const one = await app.inject({
      method: 'GET',
      url: '/v1/workspaces/asks-filter/asks?sessionId=agent_b',
    })
    expect(one.json<AskRow[]>().map((a) => a.sessionId)).toEqual(['agent_b'])
    const unknown = await app.inject({
      method: 'GET',
      url: '/v1/workspaces/asks-filter/asks?sessionId=nope',
    })
    expect(unknown.statusCode).toBe(404)
    await app.close()
  })

  it('refuses bad answers and tells already-answered from unknown', async () => {
    const app = buildApp()
    await createWs(app, 'asks-err')
    await createSession(app, 'asks-err', 'agent_a')
    const askId = await raiseAsk(app, 'asks-err', 'agent_a')

    const asAsk = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/asks-err/asks/${askId}`,
      payload: { answer: 'ask' },
    })
    expect(asAsk.statusCode).toBe(422)

    const noBody = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/asks-err/asks/${askId}`,
    })
    expect(noBody.statusCode).toBe(422)

    const sessionDeny = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/asks-err/asks/${askId}`,
      payload: { answer: 'deny', scope: 'session' },
    })
    expect(sessionDeny.statusCode).toBe(422)

    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/asks-err/asks/nope',
      payload: { answer: 'allow' },
    })
    expect(unknown.statusCode).toBe(404)

    const first = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/asks-err/asks/${askId}`,
      payload: { answer: 'allow' },
    })
    expect(first.statusCode).toBe(200)
    const again = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/asks-err/asks/${askId}`,
      payload: { answer: 'allow' },
    })
    expect(again.statusCode).toBe(409)

    const noWs = await app.inject({ method: 'GET', url: '/v1/workspaces/nope/asks' })
    expect(noWs.statusCode).toBe(404)
    await app.close()
  })
})
