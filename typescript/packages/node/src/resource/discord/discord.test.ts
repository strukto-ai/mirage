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

import { DISCORD_COMMANDS, DISCORD_VFS_OPS, PathSpec, ResourceName } from '@struktoai/mirage-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildResource } from '../registry.ts'
import { normalizeDiscordConfig, redactDiscordConfig } from './config.ts'
import { DiscordResource } from './discord.ts'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  })
}

function urlOf(arg: unknown): string {
  if (arg instanceof URL) return arg.href
  if (arg instanceof Request) return arg.url
  return String(arg)
}

describe('DiscordResource (node)', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse([]))) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('constructs with token and exposes expected fields', () => {
    const r = new DiscordResource({ token: 'bot-test' })
    expect(r.kind).toBe(ResourceName.DISCORD)
    expect(r.isRemote).toBe(true)
    expect(r.indexTtl).toBe(600)
    expect(r.config).toEqual({ token: 'bot-test' })
    expect(typeof r.prompt).toBe('string')
    expect(typeof r.writePrompt).toBe('string')
  })

  it('commands() returns DISCORD_COMMANDS', () => {
    const r = new DiscordResource({ token: 'bot-test' })
    expect(r.commands()).toBe(DISCORD_COMMANDS)
  })

  it('ops() returns DISCORD_VFS_OPS', () => {
    const r = new DiscordResource({ token: 'bot-test' })
    expect(r.ops()).toBe(DISCORD_VFS_OPS)
  })

  it('getState() redacts token', async () => {
    const r = new DiscordResource({ token: 'bot-secret' })
    const state = await r.getState()
    expect(state.type).toBe(ResourceName.DISCORD)
    expect(state).not.toHaveProperty('needsOverride')
    expect(state).not.toHaveProperty('redactedFields')
    expect(state.config).toEqual({ token: '<REDACTED>' })
  })

  it('readdir(/<guild>/channels) calls /users/@me/guilds then /guilds/<gid>/channels', async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const u = urlOf(url)
      if (u.includes('/users/@me/guilds')) {
        return Promise.resolve(jsonResponse([{ id: 'G1', name: 'My Server' }]))
      }
      if (u.includes('/guilds/G1/channels')) {
        return Promise.resolve(
          jsonResponse([
            { id: 'C1', name: 'general', type: 0 },
            { id: 'C2', name: 'eng', type: 0 },
          ]),
        )
      }
      return Promise.resolve(jsonResponse([]))
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const r = new DiscordResource({ token: 'bot-test' })
    const out = await r.readdir(
      new PathSpec({
        original: '/mnt/discord/My Server__G1/channels',
        directory: '/mnt/discord/My Server__G1/channels',
        prefix: '/mnt/discord',
      }),
    )
    expect(out).toEqual([
      '/mnt/discord/My Server__G1/channels/general__C1',
      '/mnt/discord/My Server__G1/channels/eng__C2',
    ])
    const calls = fetchMock.mock.calls.map((c) => urlOf((c as unknown[])[0]))
    expect(calls.some((u) => u.includes('/users/@me/guilds'))).toBe(true)
    expect(calls.some((u) => u.includes('/guilds/G1/channels'))).toBe(true)
    expect(calls.every((u) => u.includes('discord.com/api'))).toBe(true)
  })

  it('sends Authorization: Bot <token> header', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse([])))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const r = new DiscordResource({ token: 'sekret-token' })
    await r.readdir(
      new PathSpec({
        original: '/mnt/discord',
        directory: '/mnt/discord',
        prefix: '/mnt/discord',
      }),
    )
    expect(fetchMock).toHaveBeenCalled()
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit | undefined
    const headers = (init?.headers ?? {}) as Record<string, string>
    expect(headers.Authorization).toBe('Bot sekret-token')
  })
})

describe('redactDiscordConfig (node)', () => {
  it('always redacts token', () => {
    expect(redactDiscordConfig({ token: 'a' })).toEqual({ token: '<REDACTED>' })
  })
})

describe('normalizeDiscordConfig', () => {
  it('passes token through unchanged', () => {
    expect(normalizeDiscordConfig({ token: 'a' })).toEqual({ token: 'a' })
  })
})

describe('node registry: discord', () => {
  it('builds discord resource with token', async () => {
    const r = await buildResource('discord', { token: 'bot-x' })
    expect(r.kind).toBe(ResourceName.DISCORD)
    expect(r).toBeInstanceOf(DiscordResource)
  })
})
