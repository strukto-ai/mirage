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

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.ts'
import { ENV_ALLOWED_HOSTS } from './env.ts'
import { DEFAULT_ALLOWED_HOSTS } from './host_validation_constants.ts'
import {
  isHostAllowed,
  parseAllowedHosts,
  resolveAllowedHosts,
  stripPort,
} from './host_validation.ts'

describe('parseAllowedHosts', () => {
  it('falls back to defaults when value is undefined', () => {
    expect(parseAllowedHosts(undefined)).toEqual([...DEFAULT_ALLOWED_HOSTS])
  })

  it('falls back to defaults when value is empty or whitespace', () => {
    expect(parseAllowedHosts('')).toEqual([...DEFAULT_ALLOWED_HOSTS])
    expect(parseAllowedHosts('   ')).toEqual([...DEFAULT_ALLOWED_HOSTS])
  })

  it('parses csv values', () => {
    expect(parseAllowedHosts('a,b,c')).toEqual(['a', 'b', 'c'])
    expect(parseAllowedHosts(' a , b , c ')).toEqual(['a', 'b', 'c'])
  })

  it('passes wildcard through unchanged', () => {
    expect(parseAllowedHosts('*')).toEqual(['*'])
    expect(parseAllowedHosts('*,localhost')).toEqual(['*', 'localhost'])
  })
})

describe('stripPort', () => {
  it('strips the port from well-formed hosts', () => {
    expect(stripPort('127.0.0.1')).toBe('127.0.0.1')
    expect(stripPort('127.0.0.1:8765')).toBe('127.0.0.1')
    expect(stripPort('localhost:8765')).toBe('localhost')
  })

  it('strips the brackets from well-formed IPv6 hosts', () => {
    expect(stripPort('[::1]')).toBe('::1')
    expect(stripPort('[::1]:8765')).toBe('::1')
  })

  it('returns the raw input when the suffix after "]" is not exactly ":digits"', () => {
    expect(stripPort('[::1]evil')).toBe('[::1]evil')
    expect(stripPort('[::1]:8765x')).toBe('[::1]:8765x')
    expect(stripPort('[::1].attacker.tld')).toBe('[::1].attacker.tld')
  })

  it('returns the raw input when the bracket is never closed', () => {
    expect(stripPort('[::1')).toBe('[::1')
  })

  it('returns the raw input when the non-bracketed port is not digits', () => {
    expect(stripPort('127.0.0.1:8765x')).toBe('127.0.0.1:8765x')
  })

  it('returns the raw input for empty-host malformed values', () => {
    expect(stripPort(':8765')).toBe(':8765')
    expect(stripPort('[]')).toBe('[]')
  })
})

describe('isHostAllowed: malformed Host headers fail closed', () => {
  it('rejects bracketed IPv6 hosts with trailing junk after "]"', () => {
    expect(isHostAllowed('[::1]evil', DEFAULT_ALLOWED_HOSTS)).toBe(false)
    expect(isHostAllowed('[::1]:8765x', DEFAULT_ALLOWED_HOSTS)).toBe(false)
    expect(isHostAllowed('[::1].attacker.tld', DEFAULT_ALLOWED_HOSTS)).toBe(false)
  })

  it('still accepts well-formed loopback hosts', () => {
    expect(isHostAllowed('[::1]', DEFAULT_ALLOWED_HOSTS)).toBe(true)
    expect(isHostAllowed('[::1]:8765', DEFAULT_ALLOWED_HOSTS)).toBe(true)
    expect(isHostAllowed('127.0.0.1:8765', DEFAULT_ALLOWED_HOSTS)).toBe(true)
  })
})

describe('resolveAllowedHosts', () => {
  const originalEnv = process.env[ENV_ALLOWED_HOSTS]

  afterEach(() => {
    if (originalEnv === undefined) Reflect.deleteProperty(process.env, ENV_ALLOWED_HOSTS)
    else process.env[ENV_ALLOWED_HOSTS] = originalEnv
  })

  it('returns the explicit list when provided', () => {
    process.env[ENV_ALLOWED_HOSTS] = 'elsewhere'
    expect(resolveAllowedHosts(['override.example'])).toEqual(['override.example'])
  })

  it('reads the env var when no explicit list is given', () => {
    process.env[ENV_ALLOWED_HOSTS] = 'foo,bar'
    expect(resolveAllowedHosts()).toEqual(['foo', 'bar'])
  })

  it('returns defaults when env is unset', () => {
    Reflect.deleteProperty(process.env, ENV_ALLOWED_HOSTS)
    expect(resolveAllowedHosts()).toEqual([...DEFAULT_ALLOWED_HOSTS])
  })
})

describe('buildApp host header enforcement', () => {
  const originalEnv = process.env[ENV_ALLOWED_HOSTS]

  beforeEach(() => {
    Reflect.deleteProperty(process.env, ENV_ALLOWED_HOSTS)
  })

  afterEach(() => {
    if (originalEnv === undefined) Reflect.deleteProperty(process.env, ENV_ALLOWED_HOSTS)
    else process.env[ENV_ALLOWED_HOSTS] = originalEnv
  })

  it('rejects unknown host with 400 under default allowlist', async () => {
    const app = buildApp({})
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/workspaces',
        headers: { host: 'attacker.example' },
      })
      expect(res.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('rejects malformed bracketed IPv6 host with 400 under default allowlist', async () => {
    const app = buildApp({})
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/workspaces',
        headers: { host: '[::1]evil' },
      })
      expect(res.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('accepts loopback hosts under default allowlist', async () => {
    const app = buildApp({})
    try {
      for (const host of ['127.0.0.1', 'localhost', '127.0.0.1:8765']) {
        const res = await app.inject({
          method: 'GET',
          url: '/v1/workspaces',
          headers: { host },
        })
        expect(res.statusCode).toBe(200)
      }
    } finally {
      await app.close()
    }
  })

  it('extends allowlist via env var', async () => {
    process.env[ENV_ALLOWED_HOSTS] = '127.0.0.1,localhost,daemon.mirage.local'
    const app = buildApp({})
    try {
      const ok = await app.inject({
        method: 'GET',
        url: '/v1/workspaces',
        headers: { host: 'daemon.mirage.local' },
      })
      expect(ok.statusCode).toBe(200)
      const bad = await app.inject({
        method: 'GET',
        url: '/v1/workspaces',
        headers: { host: 'attacker.example' },
      })
      expect(bad.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('disables enforcement when allowedHosts contains "*"', async () => {
    const app = buildApp({ allowedHosts: ['*'] })
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/workspaces',
        headers: { host: 'anything.example' },
      })
      expect(res.statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('emits a console.warn on rejection naming the bad host', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const app = buildApp({})
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/workspaces',
        headers: { host: 'attacker.example' },
      })
      expect(res.statusCode).toBe(400)
      expect(warnSpy).toHaveBeenCalled()
      const joined = warnSpy.mock.calls.flat().join(' ')
      expect(joined).toContain('attacker.example')
    } finally {
      warnSpy.mockRestore()
      await app.close()
    }
  })
})

describe('resolveAllowedHosts config layer', () => {
  it('config beats default', () => {
    const home = mkdtempSync(join(tmpdir(), 'mir-hosts-'))
    writeFileSync(
      join(home, 'config.toml'),
      '[daemon]\nallowed_hosts = "example.com,api.example.com"\n',
    )
    expect(resolveAllowedHosts(undefined, { MIRAGE_HOME: home })).toEqual([
      'example.com',
      'api.example.com',
    ])
  })

  it('env beats config', () => {
    const home = mkdtempSync(join(tmpdir(), 'mir-hosts-'))
    writeFileSync(join(home, 'config.toml'), '[daemon]\nallowed_hosts = "file.example.com"\n')
    expect(
      resolveAllowedHosts(undefined, {
        MIRAGE_HOME: home,
        MIRAGE_ALLOWED_HOSTS: 'env.example.com',
      }),
    ).toEqual(['env.example.com'])
  })
})
