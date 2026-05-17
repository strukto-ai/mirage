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

import { generateKeyPairSync } from 'node:crypto'
import { SignJWT, importPKCS8 } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'

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

    it('accepts valid signed', async () => {
      const jwt: JWTConfig = {
        key: keys.publicPem,
        algorithm: 'RS256',
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
