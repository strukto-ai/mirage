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

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.ts'
import { AuthMode, type AuthConfig } from '../auth/config.ts'

const PATH = '/.well-known/oauth-protected-resource'
const apps: ReturnType<typeof buildApp>[] = []

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
})

async function get(authConfig: AuthConfig): Promise<{ status: number; body: unknown }> {
  const app = buildApp({
    authConfig,
    stateRoot: join(mkdtempSync(join(tmpdir(), 'mirage-oauth-')), 'state'),
  })
  apps.push(app)
  const res = await app.inject({ method: 'GET', url: PATH, headers: { host: '127.0.0.1:8765' } })
  return { status: res.statusCode, body: res.json() }
}

describe('the protected resource route', () => {
  it('says where to log in when the server has a login client', async () => {
    const { status, body } = await get({
      mode: AuthMode.Jwt,
      jwt: {
        algorithm: 'RS256',
        jwksUrl: 'https://clerk.example/.well-known/jwks.json',
        issuer: 'https://clerk.example',
        audiences: ['client_cli'],
        authorizedParties: [],
        clockSkewSeconds: 5,
        loginClientId: 'client_cli',
      },
    })
    expect(status).toBe(200)
    expect(body).toEqual({
      resource: 'http://127.0.0.1:8765',
      authorization_servers: ['https://clerk.example'],
      bearer_methods_supported: ['header'],
      client_id: 'client_cli',
    })
  })

  it.each<[string, AuthConfig]>([
    ['local', { mode: AuthMode.Local, localToken: 't' }],
    ['token', { mode: AuthMode.Token, bearerToken: 't' }],
    [
      'jwt without login',
      {
        mode: AuthMode.Jwt,
        jwt: {
          algorithm: 'HS256',
          key: 's'.repeat(32),
          issuer: 'i',
          audiences: [],
          authorizedParties: [],
          clockSkewSeconds: 5,
        },
      },
    ],
  ])('publishes no login on %s', async (_name, config) => {
    expect((await get(config)).status).toBe(404)
  })
})
