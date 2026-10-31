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

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { buildApp, type BuildAppOptions } from './app.ts'
import { AuthMode } from './auth/index.ts'
import { DaemonConfigError } from './daemon_config.ts'
import { ENV_HOME, ENV_RATE_LIMITS } from './env.ts'
import { parseRateLimits, type RateLimit, resolveRateLimits } from './rate_limit.ts'

async function statuses(
  options: BuildAppOptions,
  requests: readonly { url: string; headers?: Record<string, string> }[],
): Promise<number[]> {
  const app = buildApp(options)
  const seen: number[] = []
  for (const { url, headers } of requests) {
    seen.push((await app.inject({ method: 'GET', url, headers: headers ?? {} })).statusCode)
  }
  await app.close()
  return seen
}

describe('parseRateLimits', () => {
  it('names its limits in order', () => {
    expect(parseRateLimits(' ip=1000/minute, header:x-tenant=50/seconds,account=10/day,')).toEqual([
      { key: 'ip', rate: '1000/minute' },
      { key: 'header:x-tenant', rate: '50/seconds' },
      { key: 'account', rate: '10/day' },
    ])
  })

  it.each(['ip', 'ip=0/minute', 'ip=1/week', 'ip=x/minute', 'host=1/second', 'header:=1/second'])(
    'refuses %s',
    (text) => {
      expect(() => parseRateLimits(text)).toThrow()
    },
  )
})

describe('resolveRateLimits', () => {
  it('reads the env then config', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mir-rate-'))
    try {
      expect(resolveRateLimits(undefined, { [ENV_HOME]: home })).toEqual([
        { key: 'ip', rate: '1000/minute' },
      ])
      await writeFile(join(home, 'config.toml'), '[daemon]\nrate_limits = "account=600/minute"\n')
      expect(resolveRateLimits(undefined, { [ENV_HOME]: home }).map((l) => l.key)).toEqual([
        'account',
      ])
      const env = { [ENV_HOME]: home, [ENV_RATE_LIMITS]: 'ip=5/second' }
      expect(resolveRateLimits(undefined, env).map((l) => l.key)).toEqual(['ip'])
      expect(resolveRateLimits([], env)).toEqual([])
      expect(() => resolveRateLimits(undefined, { ...env, [ENV_RATE_LIMITS]: 'ip=5' })).toThrow(
        DaemonConfigError,
      )
      await writeFile(join(home, 'config.toml'), '[daemon]\nrate_limits = ""\n')
      expect(resolveRateLimits(undefined, { [ENV_HOME]: home })).toEqual([])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('registerRateLimits', () => {
  it('answers 429 past the rate until the window ends, leaving the public paths', async () => {
    const app = buildApp({ rateLimits: [{ key: 'ip', rate: '2/minute' }] })
    const get = (url: string) => app.inject({ method: 'GET', url })
    expect((await get('/v1/workspaces')).statusCode).toBe(200)
    expect((await get('/v1/workspaces')).statusCode).toBe(200)
    const refused = await get('/v1/workspaces')
    expect(refused.statusCode).toBe(429)
    expect(refused.json()).toEqual({ detail: 'Too Many Requests' })
    const wait = Number(refused.headers['retry-after'])
    expect(wait).toBeGreaterThanOrEqual(1)
    expect(wait).toBeLessThanOrEqual(60)
    expect((await get('/v1/health')).statusCode).toBe(200)
    expect((await get('/v1/ready')).statusCode).toBe(200)
    await app.close()
  })

  it('counts each value of a key on its own', async () => {
    const a = { 'x-tenant': 'a' }
    expect(
      await statuses({ rateLimits: [{ key: 'header:x-tenant', rate: '1/minute' }] }, [
        { url: '/v1/workspaces', headers: a },
        { url: '/v1/workspaces', headers: a },
        { url: '/v1/workspaces', headers: { 'x-tenant': 'b' } },
        { url: '/v1/workspaces' },
        { url: '/v1/workspaces' },
      ]),
    ).toEqual([200, 429, 200, 200, 200])
  })

  it('counts the workspace the path names', async () => {
    expect(
      await statuses({ rateLimits: [{ key: 'workspace', rate: '1/minute' }] }, [
        { url: '/v1/workspaces/a' },
        { url: '/v1/workspaces/a/sessions' },
        { url: '/v1/workspaces/b' },
        { url: '/v1/workspaces' },
      ]),
    ).toEqual([404, 429, 404, 200])
  })

  it('counts what a function answers', async () => {
    const byPath: RateLimit = { key: (request) => request.url, rate: '1/minute' }
    expect(
      await statuses({ rateLimits: [byPath] }, [
        { url: '/v1/workspaces' },
        { url: '/v1/workspaces' },
        { url: '/v1/jobs' },
      ]),
    ).toEqual([200, 429, 200])
  })

  it('counts the client a trusted proxy names', async () => {
    const limits = [{ key: 'ip', rate: '1/minute' }]
    const forwarded = [
      { url: '/v1/workspaces', headers: { 'x-forwarded-for': '10.0.0.1' } },
      { url: '/v1/workspaces', headers: { 'x-forwarded-for': '10.0.0.2' } },
    ]
    expect(await statuses({ rateLimits: limits, forwardedAllowIps: ['*'] }, forwarded)).toEqual([
      200, 200,
    ])
    expect(await statuses({ rateLimits: limits }, forwarded)).toEqual([200, 429])
  })
})

describe('registerRateLimits around sign-in', () => {
  it('limits authentication by default, ignoring untrusted forwarding headers', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const app = buildApp({ authConfig: { mode: AuthMode.Local, localToken: 'right' } })
    const get = (token: string, forwarded = '10.0.0.1') =>
      app.inject({
        method: 'GET',
        url: '/v1/workspaces',
        headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': forwarded },
      })
    try {
      for (let i = 0; i < 1000; i++) {
        expect((await get(`wrong-${String(i)}`, `10.0.0.${String(i % 256)}`)).statusCode).toBe(401)
      }
      const refused = await get('right')
      expect(refused.statusCode).toBe(429)
      expect(refused.json()).toEqual({ detail: 'Too Many Requests' })
      expect(Number(refused.headers['retry-after'])).toBe(60)
      expect((await app.inject({ url: '/v1/health' })).statusCode).toBe(200)
      expect((await app.inject({ url: '/v1/ready' })).statusCode).toBe(200)
      vi.setSystemTime(Date.now() + 60_001)
      expect((await get('right')).statusCode).toBe(200)
    } finally {
      await app.close()
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('lets an explicit empty list disable the default', async () => {
    const app = buildApp({ rateLimits: [] })
    try {
      for (let i = 0; i < 1001; i++) {
        expect((await app.inject({ url: '/v1/workspaces' })).statusCode).toBe(200)
      }
    } finally {
      await app.close()
    }
  })

  it('counts a bad token by address before authentication', async () => {
    const app = buildApp({
      authConfig: { mode: AuthMode.Local, localToken: 'right' },
      rateLimits: [
        { key: 'ip', rate: '1/minute' },
        { key: 'account', rate: '1/minute' },
      ],
    })
    const wrong = { authorization: 'Bearer wrong' }
    const get = () => app.inject({ method: 'GET', url: '/v1/workspaces', headers: wrong })
    expect((await get()).statusCode).toBe(401)
    expect((await get()).statusCode).toBe(429)
    await app.close()
  })

  it('still counts a request with a bare Upgrade header', async () => {
    expect(
      await statuses({ rateLimits: [{ key: 'ip', rate: '1/minute' }] }, [
        { url: '/v1/workspaces', headers: { upgrade: 'websocket' } },
        { url: '/v1/workspaces', headers: { upgrade: 'websocket' } },
      ]),
    ).toEqual([200, 429])
  })

  it('shares the HTTP authentication budget with WebSocket handshakes', async () => {
    const app = buildApp({
      authConfig: { mode: AuthMode.Local, localToken: 'right' },
      rateLimits: [{ key: 'ip', rate: '1/minute' }],
    })
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      for (const status of [401, 429]) {
        const response = await new Promise<{ status: number; retryAfter?: string }>(
          (resolve, reject) => {
            const ws = new WebSocket(
              `${address.replace('http:', 'ws:')}/v1/workspaces/missing/ssh`,
              {
                headers: { authorization: 'Bearer wrong' },
              },
            )
            ws.once('open', () => {
              ws.close()
              reject(new Error('an invalid bearer must not open a WebSocket'))
            })
            ws.once('unexpected-response', (req, res) => {
              resolve({
                status: res.statusCode ?? 0,
                ...(res.headers['retry-after'] === undefined
                  ? {}
                  : { retryAfter: res.headers['retry-after'] }),
              })
              req.destroy()
            })
            ws.once('error', reject)
          },
        )
        expect(response.status).toBe(status)
        if (status === 429) {
          expect(Number(response.retryAfter)).toBeGreaterThanOrEqual(1)
          expect(Number(response.retryAfter)).toBeLessThanOrEqual(60)
        }
      }
      expect(
        (await app.inject({ url: '/v1/workspaces', remoteAddress: '127.0.0.1' })).statusCode,
      ).toBe(429)
    } finally {
      await app.close()
    }
  })
})

describe('refusal log', () => {
  it('names the limit, not the value counted', async () => {
    const warned: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((message: string) => {
      warned.push(message)
    })
    try {
      const token = { authorization: 'Bearer secret-token' }
      expect(
        await statuses({ rateLimits: [{ key: 'header:authorization', rate: '1/minute' }] }, [
          { url: '/v1/workspaces', headers: token },
          { url: '/v1/workspaces', headers: token },
        ]),
      ).toEqual([200, 429])
    } finally {
      warn.mockRestore()
    }
    expect(warned.join('\n')).not.toContain('secret-token')
    expect(warned).toContain('rate-limiting a request past header:authorization=1/minute')
  })

  it('leaves readiness public when its URL carries a query', async () => {
    const app = buildApp({ authConfig: { mode: AuthMode.Local, localToken: 'right' } })
    expect((await app.inject({ method: 'GET', url: '/v1/ready?probe=1' })).statusCode).toBe(200)
    await app.close()
  })
})
