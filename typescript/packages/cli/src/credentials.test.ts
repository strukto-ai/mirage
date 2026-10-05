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

import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LOGIN_MAX_AGE_SECONDS,
  LoginError,
  freshToken,
  readLogin,
  removeLogin,
  renewBy,
  tokenClaims,
  writeLogin,
  type Login,
} from './credentials.ts'

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'RS256' })}.${part(claims)}.sig`
}

function login(fields: Partial<Login> = {}): Login {
  return {
    url: 'https://mirage.example.com',
    access_token: 'old',
    logged_in_at: Date.now() / 1000,
    refresh_token: 'r1',
    expires_at: Date.now() / 1000 + 3600,
    client_id: 'client_cli',
    token_endpoint: 'https://clerk.example.com/oauth/token',
    ...fields,
  }
}

describe('the stored login', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mirage-credentials-'))
    path = join(dir, 'login.json')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads back whole and only its user reads it', () => {
    const kept = login()
    writeLogin(kept, path)
    expect(readLogin(path)).toEqual(kept)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('is removed once', () => {
    const kept = login()
    writeLogin(kept, path)
    expect(removeLogin(path)).toEqual(kept)
    expect(readLogin(path)).toBeNull()
    expect(removeLogin(path)).toBeNull()
  })

  it('reads a JWT and nothing else', () => {
    expect(tokenClaims(jwt({ sub: 'user_alice' })).sub).toBe('user_alice')
    expect(tokenClaims('opaque-token')).toEqual({})
    expect(tokenClaims('a.!!!.c')).toEqual({})
  })

  it('sends a live token as it is', async () => {
    expect(await freshToken(login(), path)).toBe('old')
  })

  it('ends 30 days after sign-in however often refreshed', async () => {
    const old = login({ logged_in_at: Date.now() / 1000 - LOGIN_MAX_AGE_SECONDS - 1 })
    await expect(freshToken(old, path)).rejects.toThrow(/30 days old/)
  })

  it('asks to log in when an ended token has nothing to refresh it', async () => {
    const pasted = login({ refresh_token: null, expires_at: Date.now() / 1000 - 1 })
    await expect(freshToken(pasted, path)).rejects.toThrow(/expired; run `mirage login`/)
  })

  it('refreshes an ending token and stores it', async () => {
    const fetched = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ access_token: 'new', expires_in: 86400 }))
    const ending = login({ expires_at: Date.now() / 1000 + 10 })
    expect(await freshToken(ending, path)).toBe('new')
    const [url, init] = fetched.mock.calls[0] ?? []
    expect(url).toBe('https://clerk.example.com/oauth/token')
    expect(Object.fromEntries(init?.body as URLSearchParams)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'r1',
      client_id: 'client_cli',
    })
    const stored = readLogin(path)
    expect(stored?.access_token).toBe('new')
    expect(stored?.refresh_token).toBe('r1')
    expect(stored?.expires_at).toBeGreaterThan(Date.now() / 1000 + 86000)
  })

  it('asks to log in when the issuer refuses the refresh', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ error: 'invalid_grant' }, { status: 400 }),
    )
    const ended = login({ expires_at: Date.now() / 1000 - 1 })
    const refused = freshToken(ended, path)
    await expect(refused).rejects.toThrow(LoginError)
    await expect(refused).rejects.toThrow(/invalid_grant/)
  })

  it('renews a pasted token by its own end', () => {
    const ends = Date.now() / 1000 + 3600
    expect(renewBy(login({ refresh_token: null, expires_at: ends }))).toBe(ends)
    const kept = login()
    expect(renewBy(kept)).toBe(kept.logged_in_at + LOGIN_MAX_AGE_SECONDS)
  })
})
