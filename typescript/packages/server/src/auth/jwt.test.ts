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

import type { JWTConfig } from './config.ts'
import { JWTVerificationError, verifyJwt } from './jwt.ts'

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

function cfg(material: KeyMaterial, overrides: Partial<JWTConfig> = {}): JWTConfig {
  return {
    key: material.publicPem,
    algorithm: 'RS256',
    authorizedParties: [],
    clockSkewSeconds: 5,
    ...overrides,
  }
}

async function sign(
  material: KeyMaterial,
  claims: Record<string, unknown>,
  opts: { alg?: string; typ?: string } = {},
): Promise<string> {
  const alg = opts.alg ?? 'RS256'
  const headerExtra: Record<string, string> = {}
  if (opts.typ !== undefined) headerExtra.typ = opts.typ
  const key = await importPKCS8(material.privatePem, alg)
  return new SignJWT(claims).setProtectedHeader({ alg, ...headerExtra }).sign(key)
}

describe('verifyJwt', () => {
  let keys: KeyMaterial

  beforeAll(() => {
    keys = rsaKeys()
  })

  it('accepts valid RS256', async () => {
    const token = await sign(keys, { sub: 'agent', exp: Math.floor(Date.now() / 1000) + 60 })
    const claims = await verifyJwt(token, cfg(keys))
    expect(claims.sub).toBe('agent')
  })

  it('rejects expired', async () => {
    const token = await sign(keys, { sub: 'x', exp: Math.floor(Date.now() / 1000) - 60 })
    await expect(verifyJwt(token, cfg(keys, { clockSkewSeconds: 0 }))).rejects.toBeInstanceOf(
      JWTVerificationError,
    )
  })

  it('rejects missing exp', async () => {
    const token = await sign(keys, { sub: 'x' })
    await expect(verifyJwt(token, cfg(keys))).rejects.toBeInstanceOf(JWTVerificationError)
  })

  it('rejects wrong issuer', async () => {
    const token = await sign(keys, {
      sub: 'x',
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: 'https://attacker.example',
    })
    await expect(
      verifyJwt(token, cfg(keys, { issuer: 'https://issuer.example' })),
    ).rejects.toBeInstanceOf(JWTVerificationError)
  })

  it('rejects wrong audience', async () => {
    const token = await sign(keys, {
      sub: 'x',
      exp: Math.floor(Date.now() / 1000) + 60,
      aud: 'something-else',
    })
    await expect(verifyJwt(token, cfg(keys, { audience: 'mirage-daemon' }))).rejects.toBeInstanceOf(
      JWTVerificationError,
    )
  })

  it('rejects unauthorized party', async () => {
    const token = await sign(keys, {
      sub: 'x',
      exp: Math.floor(Date.now() / 1000) + 60,
      azp: 'https://attacker.example',
    })
    await expect(
      verifyJwt(token, cfg(keys, { authorizedParties: ['https://app.example'] })),
    ).rejects.toBeInstanceOf(JWTVerificationError)
  })

  it('accepts matching authorized party', async () => {
    const token = await sign(keys, {
      sub: 'x',
      exp: Math.floor(Date.now() / 1000) + 60,
      azp: 'https://other.example',
    })
    const claims = await verifyJwt(
      token,
      cfg(keys, { authorizedParties: ['https://app.example', 'https://other.example'] }),
    )
    expect(claims.sub).toBe('x')
  })

  it('rejects bad typ header', async () => {
    const token = await sign(
      keys,
      { sub: 'x', exp: Math.floor(Date.now() / 1000) + 60 },
      { typ: 'NotAJWT' },
    )
    await expect(verifyJwt(token, cfg(keys))).rejects.toBeInstanceOf(JWTVerificationError)
  })

  it('rejects algorithm mismatch', async () => {
    const token = await sign(keys, { sub: 'x', exp: Math.floor(Date.now() / 1000) + 60 })
    await expect(verifyJwt(token, cfg(keys, { algorithm: 'ES256' }))).rejects.toBeInstanceOf(
      JWTVerificationError,
    )
  })

  it('accepts within clock skew', async () => {
    const token = await sign(keys, { sub: 'x', exp: Math.floor(Date.now() / 1000) - 5 })
    const claims = await verifyJwt(token, cfg(keys, { clockSkewSeconds: 30 }))
    expect(claims.sub).toBe('x')
  })
})
