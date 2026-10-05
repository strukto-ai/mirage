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

import { createPublicKey, generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { SignJWT, exportJWK, importPKCS8 } from 'jose'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Workspace } from '@struktoai/mirage-node'

import { buildApp } from '../app.ts'
import type { AuthConfig, JWTConfig } from './config.ts'

interface KeyMaterial {
  privatePem: string
  publicPem: string
}

function rsaKeys(): KeyMaterial {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
  }
}

async function signRs256(material: KeyMaterial, claims: Record<string, unknown>): Promise<string> {
  const key = await importPKCS8(material.privatePem, 'RS256')
  return new SignJWT(claims).setProtectedHeader({ alg: 'RS256' }).sign(key)
}

async function inject(app: ReturnType<typeof buildApp>, path: string, authHeader?: string) {
  return app.inject({
    method: 'GET',
    url: path,
    headers: authHeader === undefined ? {} : { authorization: authHeader },
  })
}

describe('AuthMiddleware integration', () => {
  describe('local mode', () => {
    it('accepts correct bearer', async () => {
      const auth: AuthConfig = { mode: 'local', localToken: 'correct' }
      const app = buildApp({ authConfig: auth })
      try {
        const r = await inject(app, '/v1/workspaces', 'Bearer correct')
        expect(r.statusCode).toBe(200)
      } finally {
        await app.close()
      }
    })

    it('rejects wrong bearer', async () => {
      const auth: AuthConfig = { mode: 'local', localToken: 'correct' }
      const app = buildApp({ authConfig: auth })
      try {
        const r = await inject(app, '/v1/workspaces', 'Bearer wrong')
        expect(r.statusCode).toBe(401)
      } finally {
        await app.close()
      }
    })

    it('rejects missing header', async () => {
      const auth: AuthConfig = { mode: 'local', localToken: 'correct' }
      const app = buildApp({ authConfig: auth })
      try {
        const r = await inject(app, '/v1/workspaces')
        expect(r.statusCode).toBe(401)
      } finally {
        await app.close()
      }
    })

    it('no token configured lets everything through', async () => {
      const auth: AuthConfig = { mode: 'local' }
      const app = buildApp({ authConfig: auth })
      try {
        const r = await inject(app, '/v1/workspaces')
        expect(r.statusCode).toBe(200)
      } finally {
        await app.close()
      }
    })
  })

  describe('token mode', () => {
    it('accepts correct token', async () => {
      const auth: AuthConfig = { mode: 'token', bearerToken: 'pat' }
      const app = buildApp({ authConfig: auth })
      try {
        const r = await inject(app, '/v1/workspaces', 'Bearer pat')
        expect(r.statusCode).toBe(200)
      } finally {
        await app.close()
      }
    })

    it('rejects wrong token', async () => {
      const auth: AuthConfig = { mode: 'token', bearerToken: 'pat' }
      const app = buildApp({ authConfig: auth })
      try {
        const r = await inject(app, '/v1/workspaces', 'Bearer other')
        expect(r.statusCode).toBe(401)
      } finally {
        await app.close()
      }
    })

    it('rejects JWT-shaped value', async () => {
      const auth: AuthConfig = { mode: 'token', bearerToken: 'pat' }
      const app = buildApp({ authConfig: auth })
      try {
        const r = await inject(app, '/v1/workspaces', 'Bearer aaaa.bbbb.cccc')
        expect(r.statusCode).toBe(401)
      } finally {
        await app.close()
      }
    })
  })

  describe('jwt mode', () => {
    let keys: KeyMaterial

    beforeAll(() => {
      keys = rsaKeys()
    })

    it('checks a token against the published key set', async () => {
      const jwk = { ...(await exportJWK(createPublicKey(keys.publicPem))), kid: 'k1', use: 'sig' }
      const keySet = createServer((_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ keys: [jwk] }))
      })
      await new Promise<void>((resolve) => keySet.listen(0, '127.0.0.1', resolve))
      const port = (keySet.address() as AddressInfo).port
      const app = buildApp({
        authConfig: {
          mode: 'jwt',
          jwt: {
            algorithm: 'RS256',
            jwksUrl: `http://127.0.0.1:${String(port)}/jwks.json`,
            audiences: [],
            authorizedParties: [],
            clockSkewSeconds: 5,
          },
        },
      })
      const signing = await importPKCS8(keys.privatePem, 'RS256')
      const claims = { sub: 'agent', exp: Math.floor(Date.now() / 1000) + 60 }
      try {
        const signed = await new SignJWT(claims)
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
          .sign(signing)
        const unknown = await new SignJWT(claims)
          .setProtectedHeader({ alg: 'RS256', kid: 'k9' })
          .sign(signing)
        expect((await inject(app, '/v1/workspaces', `Bearer ${signed}`)).statusCode).toBe(200)
        expect((await inject(app, '/v1/workspaces', `Bearer ${unknown}`)).statusCode).toBe(401)
      } finally {
        await app.close()
        keySet.close()
      }
    })

    it('accepts valid signed', async () => {
      const jwt: JWTConfig = {
        key: keys.publicPem,
        algorithm: 'RS256',
        audiences: [],
        authorizedParties: [],
        clockSkewSeconds: 5,
      }
      const app = buildApp({ authConfig: { mode: 'jwt', jwt } })
      try {
        const token = await signRs256(keys, {
          sub: 'agent',
          exp: Math.floor(Date.now() / 1000) + 60,
        })
        const r = await inject(app, '/v1/workspaces', `Bearer ${token}`)
        expect(r.statusCode).toBe(200)
      } finally {
        await app.close()
      }
    })

    it('rejects opaque bearer', async () => {
      const jwt: JWTConfig = {
        key: keys.publicPem,
        algorithm: 'RS256',
        audiences: [],
        authorizedParties: [],
        clockSkewSeconds: 5,
      }
      const app = buildApp({ authConfig: { mode: 'jwt', jwt } })
      try {
        const r = await inject(app, '/v1/workspaces', 'Bearer opaque')
        expect(r.statusCode).toBe(401)
      } finally {
        await app.close()
      }
    })

    it('rejects expired', async () => {
      const jwt: JWTConfig = {
        key: keys.publicPem,
        algorithm: 'RS256',
        audiences: [],
        authorizedParties: [],
        clockSkewSeconds: 0,
      }
      const app = buildApp({ authConfig: { mode: 'jwt', jwt } })
      try {
        const token = await signRs256(keys, {
          sub: 'agent',
          exp: Math.floor(Date.now() / 1000) - 60,
        })
        const r = await inject(app, '/v1/workspaces', `Bearer ${token}`)
        expect(r.statusCode).toBe(401)
      } finally {
        await app.close()
      }
    })
  })

  describe('accounts', () => {
    let keys: KeyMaterial
    let root: string

    beforeAll(() => {
      keys = rsaKeys()
    })
    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'accounts-'))
    })
    afterEach(async () => {
      await rm(root, { recursive: true, force: true })
    })

    const jwtApp = (): ReturnType<typeof buildApp> =>
      buildApp({
        authConfig: {
          mode: 'jwt',
          jwt: {
            key: keys.publicPem,
            algorithm: 'RS256',
            audiences: [],
            authorizedParties: [],
            clockSkewSeconds: 5,
          },
        },
        stateRoot: join(root, 'state'),
        snapshotStore: { bucket: 'snaps', region: 'us-east-1' },
      })

    const bearer = async (claims: Record<string, unknown>): Promise<Record<string, string>> => ({
      authorization: `Bearer ${await signRs256(keys, { exp: Math.floor(Date.now() / 1000) + 60, ...claims })}`,
    })

    const RAM = { config: { mounts: { '/': { vfs: 'ram', mode: 'WRITE' } } } }

    it('rejects a token without sub', async () => {
      const app = jwtApp()
      try {
        const r = await app.inject({
          method: 'GET',
          url: '/v1/workspaces',
          headers: await bearer({}),
        })
        expect(r.statusCode).toBe(401)
      } finally {
        await app.close()
      }
    })

    it('lets an account reach only its own workspaces', async () => {
      const app = jwtApp()
      const alice = await bearer({ sub: 'alice' })
      const bob = await bearer({ sub: 'bob' })
      try {
        let r = await app.inject({
          method: 'POST',
          url: '/v1/workspaces',
          headers: alice,
          payload: { ...RAM, id: 'a' },
        })
        expect(r.statusCode, r.body).toBe(201)
        r = await app.inject({
          method: 'POST',
          url: '/v1/workspaces/a/shell',
          headers: alice,
          payload: { command: 'echo hi' },
        })
        expect(r.statusCode, r.body).toBe(200)
        const jobId = r.headers['x-mirage-job-id'] as string
        r = await app.inject({ method: 'GET', url: '/v1/workspaces', headers: alice })
        expect(r.json()).toHaveLength(1)
        r = await app.inject({ method: 'GET', url: '/v1/workspaces', headers: bob })
        expect(r.json()).toEqual([])
        const denied: [string, string, Record<string, unknown> | undefined][] = [
          ['GET', '/v1/workspaces/a', undefined],
          ['DELETE', '/v1/workspaces/a', undefined],
          ['POST', '/v1/workspaces/a/shell', { command: 'echo x' }],
          ['POST', '/v1/workspaces/a/read', { path: '/x' }],
          ['POST', '/v1/workspaces/a/rpc', {}],
          ['POST', '/v1/workspaces/a/mcp', {}],
          ['POST', '/v1/workspaces/a/sessions', {}],
          ['GET', '/v1/workspaces/a/sessions', undefined],
          ['POST', '/v1/workspaces/a/clone', {}],
          ['POST', '/v1/workspaces/a/close', undefined],
          ['POST', '/v1/workspaces/a/cancel', undefined],
          ['POST', '/v1/workspaces/a/kill', undefined],
          ['GET', '/v1/workspaces/a/snapshot', undefined],
          ['POST', '/v1/workspaces/a/snapshot', { key: 's.tar' }],
          ['GET', `/v1/jobs/${jobId}`, undefined],
          ['DELETE', `/v1/jobs/${jobId}`, undefined],
          ['POST', `/v1/jobs/${jobId}/wait`, {}],
        ]
        for (const [method, url, payload] of denied) {
          r = await app.inject({
            method: method as 'GET',
            url,
            headers: bob,
            ...(payload !== undefined ? { payload } : {}),
          })
          expect(r.statusCode, `${method} ${url}`).toBe(404)
        }
        r = await app.inject({ method: 'GET', url: '/v1/jobs', headers: bob })
        expect(r.json()).toEqual([])
        // The id is taken, whoever asks; bob learns no more than that.
        r = await app.inject({
          method: 'POST',
          url: '/v1/workspaces',
          headers: bob,
          payload: { ...RAM, id: 'a' },
        })
        expect(r.statusCode).toBe(409)
        r = await app.inject({ method: 'GET', url: '/v1/workspaces/a', headers: alice })
        expect(r.statusCode).toBe(200)
      } finally {
        await app.close()
      }
    })

    it('reopens a stored workspace only for its owner', async () => {
      const first = jwtApp()
      try {
        const r = await first.inject({
          method: 'POST',
          url: '/v1/workspaces',
          headers: await bearer({ sub: 'alice' }),
          payload: { ...RAM, id: 'a' },
        })
        expect(r.statusCode, r.body).toBe(201)
      } finally {
        await first.close()
      }
      // A restarted daemon over the same state root.
      const second = jwtApp()
      try {
        let r = await second.inject({
          method: 'POST',
          url: '/v1/workspaces',
          headers: await bearer({ sub: 'bob' }),
          payload: { ...RAM, id: 'a' },
        })
        expect(r.statusCode).toBe(409)
        r = await second.inject({
          method: 'POST',
          url: '/v1/workspaces',
          headers: await bearer({ sub: 'alice' }),
          payload: { ...RAM, id: 'a' },
        })
        expect(r.statusCode, r.body).toBe(201)
      } finally {
        await second.close()
      }
    })

    it('refuses an account the shutdown', async () => {
      let exited = false
      const app = buildApp({
        authConfig: {
          mode: 'jwt',
          jwt: {
            key: keys.publicPem,
            algorithm: 'RS256',
            audiences: [],
            authorizedParties: [],
            clockSkewSeconds: 5,
          },
        },
        stateRoot: join(root, 'state'),
        onIdleExit: () => {
          exited = true
        },
      })
      try {
        const r = await app.inject({
          method: 'POST',
          url: '/v1/shutdown',
          headers: await bearer({ sub: 'alice' }),
        })
        expect(r.statusCode).toBe(403)
        expect(exited).toBe(false)
      } finally {
        await app.close()
      }
    })

    it("keeps an account's snapshot keys under its own prefix", async () => {
      const app = jwtApp()
      const alice = await bearer({ sub: 'alice' })
      const bob = await bearer({ sub: 'bob' })
      try {
        await app.inject({
          method: 'POST',
          url: '/v1/workspaces',
          headers: alice,
          payload: { ...RAM, id: 'a' },
        })
        const save = vi.spyOn(app.registry.get('a').runner.ws, 'snapshot').mockResolvedValue(42)
        let r = await app.inject({
          method: 'POST',
          url: '/v1/workspaces/a/snapshot',
          headers: alice,
          payload: { key: 's.tar' },
        })
        expect(r.json()).toEqual({ id: 'a', key: 's.tar', size: 42 })
        expect(save.mock.calls[0]?.[0]).toBe('accounts/alice/s.tar')
        r = await app.inject({
          method: 'POST',
          url: '/v1/workspaces/a/snapshot',
          headers: alice,
          payload: { key: '../x.tar' },
        })
        expect(r.statusCode).toBe(400)
        const load = vi
          .spyOn(Workspace, 'load')
          .mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }))
        r = await app.inject({
          method: 'POST',
          url: '/v1/workspaces/load',
          headers: bob,
          payload: { key: 's.tar' },
        })
        expect(r.statusCode).toBe(400)
        expect(load.mock.calls[0]?.[0]).toBe('accounts/bob/s.tar')
      } finally {
        vi.restoreAllMocks()
        await app.close()
      }
    })

    it('reads a leading slash as the same key', async () => {
      const app = buildApp({
        stateRoot: join(root, 'state'),
        snapshotStore: { bucket: 'snaps', region: 'us-east-1' },
      })
      try {
        await app.inject({ method: 'POST', url: '/v1/workspaces', payload: { ...RAM, id: 'a' } })
        const save = vi.spyOn(app.registry.get('a').runner.ws, 'snapshot').mockResolvedValue(42)
        const r = await app.inject({
          method: 'POST',
          url: '/v1/workspaces/a/snapshot',
          payload: { key: '/lead.tar' },
        })
        expect(r.statusCode, r.body).toBe(200)
        expect(save.mock.calls[0]?.[0]).toBe('lead.tar')
      } finally {
        vi.restoreAllMocks()
        await app.close()
      }
    })

    it('refuses a create of an id a load is building', async () => {
      // A create that took over a load's claim could register first, and the
      // load's failure would then drop the owner record of a live workspace.
      const app = jwtApp()
      const alice = await bearer({ sub: 'alice' })
      let loading = (): void => undefined
      const started = new Promise<void>((resolve) => {
        loading = resolve
      })
      let finish = (): void => undefined
      const held = new Promise<void>((resolve) => {
        finish = resolve
      })
      vi.spyOn(Workspace, 'load').mockImplementation(async () => {
        loading()
        await held
        throw new Error('not a snapshot')
      })
      try {
        const load = app.inject({
          method: 'POST',
          url: '/v1/workspaces/load',
          headers: alice,
          payload: { key: 's.tar', id: 'w' },
        })
        await started
        let r = await app.inject({
          method: 'POST',
          url: '/v1/workspaces',
          headers: alice,
          payload: { ...RAM, id: 'w' },
        })
        expect(r.statusCode).toBe(409)
        finish()
        expect((await load).statusCode).toBe(400)
        r = await app.inject({
          method: 'POST',
          url: '/v1/workspaces',
          headers: alice,
          payload: { ...RAM, id: 'w' },
        })
        expect(r.statusCode, r.body).toBe(201)
      } finally {
        vi.restoreAllMocks()
        await app.close()
      }
    })

    it('leaves the id free after a failed create', async () => {
      const app = jwtApp()
      try {
        let r = await app.inject({
          method: 'POST',
          url: '/v1/workspaces',
          headers: await bearer({ sub: 'alice' }),
          payload: { config: { ...RAM.config, secrets: { prod: { source: 'nope' } } }, id: 'w' },
        })
        expect(r.statusCode).toBe(400)
        r = await app.inject({
          method: 'POST',
          url: '/v1/workspaces',
          headers: await bearer({ sub: 'bob' }),
          payload: { ...RAM, id: 'w' },
        })
        expect(r.statusCode, r.body).toBe(201)
      } finally {
        await app.close()
      }
    })

    it('leaves state from before accounts to no account', async () => {
      const local = buildApp({ stateRoot: join(root, 'state') })
      try {
        let r = await local.inject({
          method: 'POST',
          url: '/v1/workspaces',
          payload: { ...RAM, id: 'w' },
        })
        expect(r.statusCode, r.body).toBe(201)
        r = await local.inject({
          method: 'POST',
          url: '/v1/workspaces/w/shell',
          payload: { command: 'echo kept' },
        })
        expect(r.statusCode, r.body).toBe(200)
      } finally {
        await local.close()
      }
      const app = jwtApp()
      try {
        let r = await app.inject({
          method: 'POST',
          url: '/v1/workspaces',
          headers: await bearer({ sub: 'alice' }),
          payload: { ...RAM, id: 'w' },
        })
        expect(r.statusCode).toBe(409)
        r = await app.inject({
          method: 'POST',
          url: '/v1/workspaces',
          headers: await bearer({ sub: 'alice' }),
          payload: { ...RAM, id: 'fresh' },
        })
        expect(r.statusCode, r.body).toBe(201)
      } finally {
        await app.close()
      }
    })
  })

  it('health endpoint is always open', async () => {
    const auth: AuthConfig = { mode: 'local', localToken: 'correct' }
    const app = buildApp({ authConfig: auth })
    try {
      const r = await inject(app, '/v1/health')
      expect(r.statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('Authorization header without Bearer prefix rejected', async () => {
    const auth: AuthConfig = { mode: 'local', localToken: 'correct' }
    const app = buildApp({ authConfig: auth })
    try {
      const r = await inject(app, '/v1/workspaces', 'correct')
      expect(r.statusCode).toBe(401)
    } finally {
      await app.close()
    }
  })
})
