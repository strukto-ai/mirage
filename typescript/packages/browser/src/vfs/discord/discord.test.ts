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

import { DISCORD_COMMANDS } from '@struktoai/mirage-core/commands/builtin/discord/index'
import { DISCORD_OPS } from '@struktoai/mirage-core/ops/discord/index'
import { VFSName } from '@struktoai/mirage-core/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildVfs } from '../registry.ts'
import { redactDiscordConfig } from './config.ts'
import { DiscordVFS } from './discord.ts'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  })
}

describe('DiscordVFS (browser)', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse([]))) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('constructs with proxyUrl and exposes expected fields', () => {
    const r = new DiscordVFS({ proxyUrl: '/api/discord' })
    expect(r.kind).toBe(VFSName.DISCORD)
    expect(r.cachesReads).toBe(true)
    expect(r.indexTtl).toBe(600)
    expect(r.config).toEqual({ proxyUrl: '/api/discord' })
    expect(typeof r.prompt).toBe('string')
    expect(typeof r.writePrompt).toBe('string')
  })

  it('constructs with proxyUrl and getHeaders', () => {
    const headers = (): Record<string, string> => ({ 'X-Auth': 'secret' })
    const r = new DiscordVFS({ proxyUrl: '/api/discord', getHeaders: headers })
    expect(r.config.proxyUrl).toBe('/api/discord')
    expect(r.config.getHeaders).toBe(headers)
  })

  it('commands() returns DISCORD_COMMANDS', () => {
    const r = new DiscordVFS({ proxyUrl: '/api/discord' })
    expect(r.commands()).toBe(DISCORD_COMMANDS)
  })

  it('ops() returns DISCORD_OPS', () => {
    const r = new DiscordVFS({ proxyUrl: '/api/discord' })
    expect(r.ops()).toBe(DISCORD_OPS)
  })

  it('getState() redacts getHeaders but keeps proxyUrl visible', async () => {
    const headers = (): Record<string, string> => ({ 'X-Auth': 'secret' })
    const r = new DiscordVFS({ proxyUrl: '/api/discord', getHeaders: headers })
    const state = await r.getState()
    expect(state.type).toBe(VFSName.DISCORD)
    expect(state).not.toHaveProperty('needsOverride')
    expect(state).not.toHaveProperty('redactedFields')
    expect(state.config).toEqual({ proxyUrl: '/api/discord', getHeaders: '<REDACTED>' })
  })

  it('getState() omits getHeaders when not provided', async () => {
    const r = new DiscordVFS({ proxyUrl: '/api/discord' })
    const state = await r.getState()
    expect(state.config).toEqual({ proxyUrl: '/api/discord' })
    expect(state.config).not.toHaveProperty('getHeaders')
  })
})

describe('redactDiscordConfig (browser)', () => {
  it('keeps proxyUrl in clear, redacts getHeaders only when present', () => {
    expect(redactDiscordConfig({ proxyUrl: '/p' })).toEqual({ proxyUrl: '/p' })
    const headers = (): Record<string, string> => ({})
    expect(redactDiscordConfig({ proxyUrl: '/p', getHeaders: headers })).toEqual({
      proxyUrl: '/p',
      getHeaders: '<REDACTED>',
    })
  })
})

describe('browser registry: discord', () => {
  it('builds discord VFS with proxyUrl (camelCase)', async () => {
    const r = await buildVfs('discord', { proxyUrl: '/api/discord' })
    expect(r.kind).toBe(VFSName.DISCORD)
    expect(r).toBeInstanceOf(DiscordVFS)
  })

  it('builds discord VFS with snake_case proxy_url', async () => {
    const r = (await buildVfs('discord', {
      proxy_url: 'http://proxy/api/discord',
    })) as DiscordVFS
    expect(r.kind).toBe(VFSName.DISCORD)
    expect(r.config.proxyUrl).toBe('http://proxy/api/discord')
  })

  it('builds discord VFS with proxyUrl and getHeaders', async () => {
    const headers = (): Record<string, string> => ({ 'X-Auth': 'x' })
    const r = (await buildVfs('discord', {
      proxyUrl: '/api/discord',
      getHeaders: headers,
    })) as DiscordVFS
    expect(r.config.proxyUrl).toBe('/api/discord')
    expect(r.config.getHeaders).toBe(headers)
  })
})
