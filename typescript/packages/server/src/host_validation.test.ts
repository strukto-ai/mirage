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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.ts'
import {
  DEFAULT_ALLOWED_HOSTS,
  ENV_VAR,
  parseAllowedHosts,
  resolveAllowedHosts,
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

describe('resolveAllowedHosts', () => {
  const originalEnv = process.env[ENV_VAR]

  afterEach(() => {
    if (originalEnv === undefined) Reflect.deleteProperty(process.env, ENV_VAR)
    else process.env[ENV_VAR] = originalEnv
  })

  it('returns the explicit list when provided', () => {
    process.env[ENV_VAR] = 'elsewhere'
    expect(resolveAllowedHosts(['override.example'])).toEqual(['override.example'])
  })

  it('reads the env var when no explicit list is given', () => {
    process.env[ENV_VAR] = 'foo,bar'
    expect(resolveAllowedHosts()).toEqual(['foo', 'bar'])
  })

  it('returns defaults when env is unset', () => {
    Reflect.deleteProperty(process.env, ENV_VAR)
    expect(resolveAllowedHosts()).toEqual([...DEFAULT_ALLOWED_HOSTS])
  })
})

describe('buildApp host header enforcement', () => {
  const originalEnv = process.env[ENV_VAR]

  beforeEach(() => {
    Reflect.deleteProperty(process.env, ENV_VAR)
  })

  afterEach(() => {
    if (originalEnv === undefined) Reflect.deleteProperty(process.env, ENV_VAR)
    else process.env[ENV_VAR] = originalEnv
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
    process.env[ENV_VAR] = '127.0.0.1,localhost,daemon.mirage.local'
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
