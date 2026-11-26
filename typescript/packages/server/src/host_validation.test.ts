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
import { LOOPBACK_HOSTS } from './host_validation_constants.ts'
import {
  isCrossOrigin,
  isHostAllowed,
  parseAllowedHosts,
  refusal,
  resolveAllowedHosts,
  stripPort,
} from './host_validation.ts'

const LOOPBACK = [...LOOPBACK_HOSTS]

describe('parseAllowedHosts', () => {
  it('lists none when value is undefined', () => {
    expect(parseAllowedHosts(undefined)).toEqual([])
  })

  it('lists none when value is empty or whitespace', () => {
    expect(parseAllowedHosts('')).toEqual([])
    expect(parseAllowedHosts('   ')).toEqual([])
    expect(parseAllowedHosts(' , ')).toEqual([])
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
    expect(isHostAllowed('[::1]evil', LOOPBACK)).toBe(false)
    expect(isHostAllowed('[::1]:8765x', LOOPBACK)).toBe(false)
    expect(isHostAllowed('[::1].attacker.tld', LOOPBACK)).toBe(false)
  })

  it('still accepts well-formed loopback hosts', () => {
    expect(isHostAllowed('[::1]', LOOPBACK)).toBe(true)
    expect(isHostAllowed('[::1]:8765', LOOPBACK)).toBe(true)
    expect(isHostAllowed('127.0.0.1:8765', LOOPBACK)).toBe(true)
  })

  it('compares the host in any case', () => {
    expect(isHostAllowed('LOCALHOST:8765', LOOPBACK)).toBe(true)
    expect(isHostAllowed('Localhost', LOOPBACK)).toBe(true)
  })

  it('refuses a missing host unless "*" is listed', () => {
    expect(isHostAllowed('', LOOPBACK)).toBe(false)
    expect(isHostAllowed(undefined, LOOPBACK)).toBe(false)
    expect(isHostAllowed(undefined, ['*'])).toBe(true)
  })
})

describe('refusal', () => {
  it('names the setting, not the host', () => {
    const refused = refusal('attacker.example', undefined, undefined, LOOPBACK)
    expect(refused?.code).toBe('host_not_allowed')
    expect(refused?.message).toBe('host is not allowed; add it to MIRAGE_ALLOWED_HOSTS')
  })

  it('checks the host before the origin', () => {
    expect(refusal('attacker.example', 'https://evil.example', 'cross-site', LOOPBACK)?.code).toBe(
      'host_not_allowed',
    )
  })

  it('refuses another origin', () => {
    const refused = refusal('127.0.0.1:8765', 'https://evil.example', undefined, LOOPBACK)
    expect(refused?.code).toBe('origin_not_allowed')
    expect(refused?.message).toBe('cross-origin request refused')
  })

  it('lets its own requests on', () => {
    expect(refusal('127.0.0.1:8765', undefined, undefined, LOOPBACK)).toBeUndefined()
    expect(refusal('localhost:8765', 'http://localhost:8765', undefined, LOOPBACK)).toBeUndefined()
  })
})

describe('isCrossOrigin', () => {
  it('refuses other fetch sites', () => {
    expect(isCrossOrigin('127.0.0.1:8765', undefined, 'cross-site')).toBe(true)
    expect(isCrossOrigin('127.0.0.1:8765', 'https://evil.example', 'same-origin')).toBe(true)
    expect(isCrossOrigin('localhost:8765', undefined, 'same-site')).toBe(true)
  })

  it('admits its own fetch sites', () => {
    expect(isCrossOrigin('127.0.0.1:8765', undefined, 'same-origin')).toBe(false)
    expect(isCrossOrigin('127.0.0.1:8765', undefined, 'none')).toBe(false)
    expect(isCrossOrigin('127.0.0.1:8765', undefined, undefined)).toBe(false)
  })

  it('refuses another origin', () => {
    for (const origin of [
      'https://evil.example',
      'http://localhost:3000',
      'http://127.0.0.1',
      'null',
      '',
    ]) {
      expect(isCrossOrigin('127.0.0.1:8765', origin, undefined), origin).toBe(true)
    }
  })

  it('admits its own origin', () => {
    expect(isCrossOrigin('127.0.0.1:8765', 'http://127.0.0.1:8765', undefined)).toBe(false)
    expect(isCrossOrigin('[::1]:8765', 'http://[::1]:8765', undefined)).toBe(false)
    expect(isCrossOrigin('Localhost:8765', 'http://localhost:8765', undefined)).toBe(false)
    expect(isCrossOrigin('localhost:8765', 'http://LOCALHOST:8765', undefined)).toBe(false)
    expect(isCrossOrigin('mirage.example.com', 'https://mirage.example.com', 'same-origin')).toBe(
      false,
    )
  })
})

describe('resolveAllowedHosts', () => {
  const originalEnv = process.env[ENV_ALLOWED_HOSTS]

  afterEach(() => {
    if (originalEnv === undefined) Reflect.deleteProperty(process.env, ENV_ALLOWED_HOSTS)
    else process.env[ENV_ALLOWED_HOSTS] = originalEnv
  })

  it('adds the explicit list when provided', () => {
    process.env[ENV_ALLOWED_HOSTS] = 'elsewhere'
    expect(resolveAllowedHosts(['override.example'])).toEqual([...LOOPBACK, 'override.example'])
  })

  it('adds the env var when no explicit list is given', () => {
    process.env[ENV_ALLOWED_HOSTS] = 'foo,bar'
    expect(resolveAllowedHosts()).toEqual([...LOOPBACK, 'foo', 'bar'])
  })

  it('answers only the loopback names when nothing is added', () => {
    const home = mkdtempSync(join(tmpdir(), 'mir-hosts-'))
    expect(resolveAllowedHosts(undefined, { MIRAGE_HOME: home })).toEqual(LOOPBACK)
    expect(resolveAllowedHosts([])).toEqual(LOOPBACK)
  })

  it('keeps each name once, without its port and in lower case', () => {
    expect(
      resolveAllowedHosts([
        'Mirage.Example.com:8443',
        'mirage.example.com',
        '[::1]',
        'LOCALHOST',
        '[fd00::1]:8765',
        '*',
      ]),
    ).toEqual([...LOOPBACK, 'mirage.example.com', 'fd00::1', '*'])
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

  it('rejects unknown host with 403 under default allowlist', async () => {
    const app = buildApp({})
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/workspaces',
        headers: { host: 'attacker.example' },
      })
      expect(res.statusCode).toBe(403)
    } finally {
      await app.close()
    }
  })

  it('rejects malformed bracketed IPv6 host with 403 under default allowlist', async () => {
    const app = buildApp({})
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/workspaces',
        headers: { host: '[::1]evil' },
      })
      expect(res.statusCode).toBe(403)
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

  it('adds the env var to the loopback names', async () => {
    process.env[ENV_ALLOWED_HOSTS] = 'Daemon.Mirage.Local'
    const app = buildApp({})
    try {
      for (const host of ['daemon.mirage.local', '127.0.0.1:8765', 'localhost']) {
        const ok = await app.inject({ method: 'GET', url: '/v1/workspaces', headers: { host } })
        expect(ok.statusCode, host).toBe(200)
      }
      const bad = await app.inject({
        method: 'GET',
        url: '/v1/workspaces',
        headers: { host: 'attacker.example' },
      })
      expect(bad.statusCode).toBe(403)
      expect(bad.json()).toEqual({
        error: {
          code: 'host_not_allowed',
          message: 'host is not allowed; add it to MIRAGE_ALLOWED_HOSTS',
        },
      })
    } finally {
      await app.close()
    }
  })

  it('matches the host in any case', async () => {
    const app = buildApp({})
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/workspaces',
        headers: { host: 'LOCALHOST:8765' },
      })
      expect(res.statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('skips the Host check when allowedHosts contains "*"', async () => {
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
      expect(res.statusCode).toBe(403)
      expect(warnSpy).toHaveBeenCalled()
      const joined = warnSpy.mock.calls.flat().join(' ')
      expect(joined).toContain('attacker.example')
    } finally {
      warnSpy.mockRestore()
      await app.close()
    }
  })
})

describe('buildApp cross-origin refusal', () => {
  const originalEnv = process.env[ENV_ALLOWED_HOSTS]

  beforeEach(() => {
    Reflect.deleteProperty(process.env, ENV_ALLOWED_HOSTS)
  })

  afterEach(() => {
    if (originalEnv === undefined) Reflect.deleteProperty(process.env, ENV_ALLOWED_HOSTS)
    else process.env[ENV_ALLOWED_HOSTS] = originalEnv
  })

  it('refuses a page on another origin under the default allowlist', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const app = buildApp({})
    try {
      for (const headers of [
        { origin: 'https://evil.example' },
        { origin: 'http://localhost:3000' },
        { 'sec-fetch-site': 'cross-site' },
      ]) {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/workspaces',
          headers: { host: '127.0.0.1:8765', ...headers },
        })
        expect(res.statusCode, JSON.stringify(headers)).toBe(403)
        expect(res.json()).toEqual({
          error: { code: 'origin_not_allowed', message: 'cross-origin request refused' },
        })
      }
      const ok = await app.inject({
        method: 'GET',
        url: '/v1/workspaces',
        headers: {
          host: '127.0.0.1:8765',
          origin: 'http://127.0.0.1:8765',
          'sec-fetch-site': 'same-origin',
        },
      })
      expect(ok.statusCode).toBe(200)
      expect(warnSpy.mock.calls.flat().join(' ')).toContain('evil.example')
    } finally {
      warnSpy.mockRestore()
      await app.close()
    }
  })

  it('still refuses a page on another origin when allowedHosts contains "*"', async () => {
    const app = buildApp({ allowedHosts: ['*'] })
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/workspaces',
        headers: { host: 'anything.example', origin: 'https://evil.example' },
      })
      expect(res.statusCode).toBe(403)
    } finally {
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
      ...LOOPBACK,
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
    ).toEqual([...LOOPBACK, 'env.example.com'])
  })
})
