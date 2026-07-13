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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AuthMode, resolveAuthConfig, resolveLocalToken } from './config.ts'
import { ALLOWED_KEYS } from '../daemon_config.ts'

describe('resolveLocalToken', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mirage-auth-cfg-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('env wins', () => {
    const f = join(dir, 'auth_token')
    writeFileSync(f, 'from-file')
    expect(resolveLocalToken({ env: { MIRAGE_AUTH_TOKEN: 'from-env' }, tokenFile: f })).toBe(
      'from-env',
    )
  })

  it('falls back to file', () => {
    const f = join(dir, 'auth_token')
    writeFileSync(f, 'from-file')
    expect(resolveLocalToken({ env: {}, tokenFile: f })).toBe('from-file')
  })

  it('returns undefined when no source', () => {
    expect(resolveLocalToken({ env: {}, tokenFile: join(dir, 'missing') })).toBeUndefined()
  })
})

describe('resolveAuthConfig', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mirage-auth-cfg-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('defaults to local with no token', () => {
    const cfg = resolveAuthConfig({ env: {}, tokenFile: join(dir, 'missing') })
    expect(cfg.mode).toBe('local')
    expect(cfg.localToken).toBeUndefined()
    expect(cfg.bearerToken).toBeUndefined()
    expect(cfg.jwt).toBeUndefined()
  })

  it('local picks up env token', () => {
    const cfg = resolveAuthConfig({
      env: { MIRAGE_AUTH_TOKEN: 'lt' },
      tokenFile: join(dir, 'missing'),
    })
    expect(cfg.mode).toBe('local')
    expect(cfg.localToken).toBe('lt')
  })

  it('token mode requires MIRAGE_AUTH_TOKEN', () => {
    expect(() =>
      resolveAuthConfig({
        env: { MIRAGE_AUTH_MODE: 'token' },
        tokenFile: join(dir, 'missing'),
      }),
    ).toThrow(/MIRAGE_AUTH_TOKEN/)
  })

  it('token mode picks up env token', () => {
    const cfg = resolveAuthConfig({
      env: { MIRAGE_AUTH_MODE: 'token', MIRAGE_AUTH_TOKEN: 'pat' },
      tokenFile: join(dir, 'missing'),
    })
    expect(cfg.mode).toBe('token')
    expect(cfg.bearerToken).toBe('pat')
  })

  it('jwt mode requires key', () => {
    expect(() =>
      resolveAuthConfig({
        env: { MIRAGE_AUTH_MODE: 'jwt', MIRAGE_JWT_ALG: 'RS256' },
        tokenFile: join(dir, 'missing'),
      }),
    ).toThrow(/MIRAGE_JWT_PUBKEY/)
  })

  it('jwt mode requires alg', () => {
    expect(() =>
      resolveAuthConfig({
        env: { MIRAGE_AUTH_MODE: 'jwt', MIRAGE_JWT_PUBKEY: '-----BEGIN' },
        tokenFile: join(dir, 'missing'),
      }),
    ).toThrow(/MIRAGE_JWT_ALG/)
  })

  it('jwt mode with inline key', () => {
    const cfg = resolveAuthConfig({
      env: {
        MIRAGE_AUTH_MODE: 'jwt',
        MIRAGE_JWT_PUBKEY: '-----BEGIN PUBLIC KEY-----\nFAKE\n-----END PUBLIC KEY-----',
        MIRAGE_JWT_ALG: 'RS256',
        MIRAGE_JWT_ISSUER: 'https://issuer.example',
        MIRAGE_JWT_AUDIENCE: 'mirage-daemon',
        MIRAGE_JWT_AUTHORIZED_PARTIES: 'https://app.example,https://other.example',
        MIRAGE_JWT_CLOCK_SKEW_SECONDS: '12',
      },
      tokenFile: join(dir, 'missing'),
    })
    expect(cfg.mode).toBe('jwt')
    expect(cfg.jwt).toBeDefined()
    expect(cfg.jwt?.key).toContain('FAKE')
    expect(cfg.jwt?.algorithm).toBe('RS256')
    expect(cfg.jwt?.issuer).toBe('https://issuer.example')
    expect(cfg.jwt?.audience).toBe('mirage-daemon')
    expect(cfg.jwt?.authorizedParties).toEqual(['https://app.example', 'https://other.example'])
    expect(cfg.jwt?.clockSkewSeconds).toBe(12)
  })

  it('jwt mode reads pubkey from file', () => {
    const keyFile = join(dir, 'jwt.pub')
    writeFileSync(keyFile, '-----BEGIN PUBLIC KEY-----\nFROMFILE\n-----END PUBLIC KEY-----')
    const cfg = resolveAuthConfig({
      env: {
        MIRAGE_AUTH_MODE: 'jwt',
        MIRAGE_JWT_PUBKEY_FILE: keyFile,
        MIRAGE_JWT_ALG: 'RS256',
      },
      tokenFile: join(dir, 'missing'),
    })
    expect(cfg.mode).toBe('jwt')
    expect(cfg.jwt?.key).toContain('FROMFILE')
    expect(cfg.jwt?.clockSkewSeconds).toBe(5)
  })

  it('unknown mode raises', () => {
    expect(() =>
      resolveAuthConfig({
        env: { MIRAGE_AUTH_MODE: 'wat' },
        tokenFile: join(dir, 'missing'),
      }),
    ).toThrow(/MIRAGE_AUTH_MODE/)
  })
})

describe('resolveAuthConfig config table', () => {
  it('auth_mode from the table with env winning', () => {
    const cfg = resolveAuthConfig({
      env: { MIRAGE_AUTH_TOKEN: 'tok' },
      table: { auth_mode: 'token' },
    })
    expect(cfg.mode).toBe(AuthMode.Token)
    expect(cfg.bearerToken).toBe('tok')
    const envWins = resolveAuthConfig({
      env: { MIRAGE_AUTH_MODE: 'local' },
      tokenFile: '/nonexistent/token',
      table: { auth_mode: 'token' },
    })
    expect(envWins.mode).toBe(AuthMode.Local)
  })

  it('jwt settings from the table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mir-auth-'))
    const keyFile = join(dir, 'pub.pem')
    writeFileSync(keyFile, 'KEYDATA')
    const cfg = resolveAuthConfig({
      env: {},
      table: {
        auth_mode: 'jwt',
        jwt_pubkey_file: keyFile,
        jwt_alg: 'RS256',
        jwt_issuer: 'https://issuer',
        jwt_audience: 'aud',
        jwt_authorized_parties: 'a,b',
        jwt_clock_skew: '9',
      },
    })
    expect(cfg.mode).toBe(AuthMode.Jwt)
    expect(cfg.jwt?.key).toBe('KEYDATA')
    expect(cfg.jwt?.algorithm).toBe('RS256')
    expect(cfg.jwt?.issuer).toBe('https://issuer')
    expect(cfg.jwt?.audience).toBe('aud')
    expect(cfg.jwt?.authorizedParties).toEqual(['a', 'b'])
    expect(cfg.jwt?.clockSkewSeconds).toBe(9)
  })

  it('env jwt_alg beats the table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mir-auth-'))
    const keyFile = join(dir, 'pub.pem')
    writeFileSync(keyFile, 'KEYDATA')
    const cfg = resolveAuthConfig({
      env: {
        MIRAGE_AUTH_MODE: 'jwt',
        MIRAGE_JWT_PUBKEY_FILE: keyFile,
        MIRAGE_JWT_ALG: 'ES256',
      },
      table: { jwt_alg: 'RS256' },
    })
    expect(cfg.jwt?.algorithm).toBe('ES256')
  })

  it('secret keys have no config counterpart', () => {
    expect(ALLOWED_KEYS.has('jwt_pubkey')).toBe(false)
    expect(ALLOWED_KEYS.has('auth_mode')).toBe(true)
    expect(ALLOWED_KEYS.has('jwt_alg')).toBe(true)
  })
})
