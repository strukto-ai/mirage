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

import { createPrivateKey, createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitHubAccount } from '../../accessor/github.ts'
import { tokenHeader } from '../../commands/cli/builtin/gh/repo.ts'
import { registerSecrets } from '../../secrets/registry.ts'
import { resolveConfigSecrets } from '../../secrets/sources.ts'
import { parseConfigWithSchema, redactedConfigDump, z } from '../../vfs/secrets.ts'
import { AppTokens, pkcs8Key } from './app.ts'
import { HttpGitHubTransport } from './client.ts'
import { GhConfig, GitHubConfig } from './config.ts'
import { login } from './repo.ts'

const BASE = 'https://api.example.test'
// GitHub's download format, PKCS#1.
const { privateKey: PEM, publicKey: PUBLIC } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

interface Seen {
  method: string
  path: string
  authorization: string | null
  body: string | null
}

const SEEN: Seen[] = []
let EXPIRES_IN = 3600
let REPOSITORIES: unknown[] = [{ name: 'r', owner: { login: 'acme' } }]
let minted = 0
const REAL_FETCH = globalThis.fetch

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  SEEN.length = 0
  EXPIRES_IN = 3600
  REPOSITORIES = [{ name: 'r', owner: { login: 'acme' } }]
  minted = 0
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    const path = new URL(req.url).pathname
    SEEN.push({
      method: req.method,
      path,
      authorization: req.headers.get('authorization'),
      body: req.method === 'GET' ? null : await req.text(),
    })
    if (req.method === 'POST' && path === '/app/installations/42/access_tokens') {
      minted += 1
      const expires = new Date(Date.now() + EXPIRES_IN * 1000).toISOString()
      return reply({ token: `ghs_${String(minted)}`, expires_at: expires }, 201)
    }
    if (path === '/installation/repositories') {
      return reply({ total_count: REPOSITORIES.length, repositories: REPOSITORIES })
    }
    if (path === '/user') {
      return reply({ message: 'Resource not accessible by integration' }, 403)
    }
    return reply({ ok: true })
  }) as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = REAL_FETCH
})

function app(extra: Record<string, unknown> = {}) {
  return { appId: 7, privateKey: PEM, installationId: 42, ...extra }
}

function transport(extra: Record<string, unknown> = {}): HttpGitHubTransport {
  return new HttpGitHubTransport({ app: app(extra), baseUrl: BASE })
}

function mints(): Seen[] {
  return SEEN.filter((seen) => seen.path.endsWith('/access_tokens'))
}

function calls(): Seen[] {
  return SEEN.filter((seen) => !seen.path.endsWith('/access_tokens'))
}

function decoded(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<string, unknown>
}

describe('GitHub App auth', () => {
  it('mints an installation token with an App JWT and rides it', async () => {
    await transport().get('/repos/o/r')
    const [mint] = mints()
    const jwt = (mint?.authorization ?? '').replace(/^bearer /i, '')
    const [header = '', payload = '', signature = ''] = jwt.split('.')
    expect(decoded(header).alg).toBe('RS256')
    const claims = decoded(payload)
    expect(claims.iss).toBe(7)
    expect(Number(claims.exp) - Number(claims.iat)).toBeLessThanOrEqual(600)
    const signed = Buffer.from(`${header}.${payload}`)
    expect(verify('sha256', signed, PUBLIC, Buffer.from(signature, 'base64url'))).toBe(true)
    expect(calls().map((seen) => seen.authorization)).toEqual(['token ghs_1'])
  })

  it('keeps a token until it is near expiry', async () => {
    const github = transport()
    await github.get('/repos/o/r')
    await github.get('/repos/o/r')
    expect(mints()).toHaveLength(1)
    expect(await github.token()).toBe('ghs_1')
  })

  it('mints the next token five minutes before the last expires', async () => {
    EXPIRES_IN = 240
    const github = transport()
    await github.get('/repos/o/r')
    await github.get('/repos/o/r')
    expect(mints()).toHaveLength(2)
    expect(calls().map((seen) => seen.authorization)).toEqual(['token ghs_1', 'token ghs_2'])
  })

  it("leaves a caller's own Authorization alone, and mints nothing for it", async () => {
    const own = { Authorization: 'Bearer other' }
    await transport().request('POST', '/repos/o/r/issues', { title: 't' }, undefined, own)
    const fixed = new HttpGitHubTransport({ token: 'ghp_x', baseUrl: BASE })
    await fixed.request('GET', '/repos/o/r', undefined, undefined, own)
    await fixed.get('/repos/o/r')
    expect(mints()).toHaveLength(0)
    expect(calls().map((seen) => seen.authorization)).toEqual([
      'Bearer other',
      'Bearer other',
      'token ghp_x',
    ])
  })

  it('mints once for concurrent first calls', async () => {
    const github = transport()
    await Promise.all([github.get('/a'), github.get('/b'), github.token()])
    expect(mints()).toHaveLength(1)
  })

  it('narrows the token to the configured repositories and permissions', async () => {
    await transport({ repositories: ['r'], permissions: { contents: 'read' } }).get('/repos/o/r')
    expect(JSON.parse(mints()[0]?.body ?? '')).toMatchObject({
      repositories: ['r'],
      permissions: { contents: 'read' },
    })
  })

  it('asks for no narrowing when none is configured', async () => {
    await transport().get('/repos/o/r')
    // Octokit sends no body at all when there is nothing to narrow.
    const raw = mints()[0]?.body ?? ''
    const body = JSON.parse(raw === '' ? '{}' : raw) as Record<string, unknown>
    expect(body.repositories).toBeUndefined()
    expect(body.permissions).toBeUndefined()
  })

  it("puts the minted token in git clone's header", async () => {
    const account = new GitHubAccount({ app: app() } as GhConfig, transport())
    expect(await tokenHeader(account)).toEqual({
      Authorization: `Basic ${btoa('x-access-token:ghs_1')}`,
    })
  })

  it("names the installation's account as the login, not /user's", async () => {
    expect(await login(transport(), true)).toBe('acme')
    expect(SEEN.some((seen) => seen.path === '/user')).toBe(false)
  })

  it('refuses a login for an installation that reaches no repository', async () => {
    REPOSITORIES = []
    await expect(login(transport(), true)).rejects.toThrow('"OWNER/REPO"')
  })

  it('shares one token between accounts that join', async () => {
    const first = new GitHubAccount({ app: app(), baseUrl: BASE } as GhConfig)
    const second = new GitHubAccount({ app: app(), baseUrl: BASE } as GhConfig)
    second.join([first])
    await first.transport.get('/a')
    await second.transport.get('/b')
    expect(mints()).toHaveLength(1)
  })
})

describe('AppTokens', () => {
  it('mints again once the cached token is within the margin', async () => {
    const tokens = new AppTokens(app())
    const now = Date.now() / 1000
    let n = 0
    const mint = () => Promise.resolve<[string, number]>([`t${String(++n)}`, now + 299])
    expect(await tokens.token(mint)).toBe('t1')
    expect(await tokens.token(mint)).toBe('t2')
  })
})

describe('pkcs8Key', () => {
  it('wraps a PKCS#1 key as node does, and WebCrypto imports it', async () => {
    const wrapped = pkcs8Key(PEM)
    const node = createPrivateKey(PEM).export({ type: 'pkcs8', format: 'pem' }) as string
    expect(wrapped).toBe(node.trim())
    const der = Buffer.from(wrapped.replace(/-----[^-]+-----|\s/g, ''), 'base64')
    const key = await crypto.subtle.importKey(
      'pkcs8',
      der,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    expect(key.type).toBe('private')
    expect(createPublicKey(wrapped).export({ type: 'spki', format: 'pem' })).toBe(PUBLIC)
  })

  it('reads escaped newlines and leaves PKCS#8 as it is', () => {
    const node = createPrivateKey(PEM).export({ type: 'pkcs8', format: 'pem' }) as string
    expect(pkcs8Key(PEM.replace(/\n/g, '\\n'))).toBe(node.trim())
    expect(pkcs8Key(node)).toBe(node.trim())
  })
})

describe('GitHub auth config', () => {
  const repo = { owner: 'o', repo: 'r' }

  it.each([
    ['both', { token: 't', app: app() }],
    ['neither', {}],
  ])('refuses %s', (got, auth) => {
    expect(() => parseConfigWithSchema(GitHubConfig, { ...repo, ...auth })).toThrow(
      `exactly one of token or app; got ${got}`,
    )
    expect(() => GhConfig.parse(auth)).toThrow(`exactly one of token or app; got ${got}`)
  })

  it('reads the snake_case spellings of an app block', () => {
    const config = parseConfigWithSchema(GitHubConfig, {
      ...repo,
      app: { app_id: 7, private_key: 'k', installation_id: 42 },
    })
    expect(config.app).toEqual({ appId: 7, privateKey: 'k', installationId: 42 })
  })

  it('refuses an unknown key in an app block', () => {
    expect(() =>
      parseConfigWithSchema(GitHubConfig, { ...repo, app: { ...app(), installation: 1 } }),
    ).toThrow()
  })

  it('reads a pointer inside the app block from its secret source', async () => {
    // A stand-in vault: core registers no source of its own.
    registerSecrets('github-app-vault', z.strictObject({}), () =>
      Promise.resolve({ fields: { PRIVATE_KEY: PEM } }),
    )
    const raw = await resolveConfigSecrets({
      ...repo,
      app: {
        app_id: 7,
        installation_id: 42,
        private_key: { from: 'github-app-vault', ref: 'github-app', key: 'PRIVATE_KEY' },
      },
    })
    expect(parseConfigWithSchema(GitHubConfig, raw).app?.privateKey).toBe(PEM)
  })

  it("redacts the App's private key", () => {
    const dump = redactedConfigDump(GitHubConfig, { ...repo, app: app() })
    expect(dump.app).toMatchObject({ appId: 7, privateKey: '<REDACTED>', installationId: 42 })
  })
})
