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

import { PathSpec, ResourceName, SLACK_COMMANDS, SLACK_VFS_OPS } from '@struktoai/mirage-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildResource } from '../registry.ts'
import { redactSlackConfig } from './config.ts'
import { SlackResource } from './slack.ts'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  })
}

describe('SlackResource (browser)', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse({ ok: true })),
    ) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('constructs with proxyUrl and exposes expected fields', () => {
    const r = new SlackResource({ proxyUrl: '/api/slack' })
    expect(r.kind).toBe(ResourceName.SLACK)
    expect(r.isRemote).toBe(true)
    expect(r.indexTtl).toBe(600)
    expect(r.config).toEqual({ proxyUrl: '/api/slack' })
    expect(typeof r.prompt).toBe('string')
    expect(typeof r.writePrompt).toBe('string')
  })

  it('constructs with proxyUrl and getHeaders', () => {
    const headers = (): Record<string, string> => ({ 'X-Auth': 'secret' })
    const r = new SlackResource({ proxyUrl: '/api/slack', getHeaders: headers })
    expect(r.config.proxyUrl).toBe('/api/slack')
    expect(r.config.getHeaders).toBe(headers)
  })

  it('commands() returns SLACK_COMMANDS', () => {
    const r = new SlackResource({ proxyUrl: '/api/slack' })
    expect(r.commands()).toBe(SLACK_COMMANDS)
  })

  it('ops() returns SLACK_VFS_OPS', () => {
    const r = new SlackResource({ proxyUrl: '/api/slack' })
    expect(r.ops()).toBe(SLACK_VFS_OPS)
  })

  it('getState() redacts getHeaders but keeps proxyUrl visible', async () => {
    const headers = (): Record<string, string> => ({ 'X-Auth': 'secret' })
    const r = new SlackResource({ proxyUrl: '/api/slack', getHeaders: headers })
    const state = await r.getState()
    expect(state.type).toBe(ResourceName.SLACK)
    expect(state).not.toHaveProperty('needsOverride')
    expect(state).not.toHaveProperty('redactedFields')
    expect(state.config).toEqual({ proxyUrl: '/api/slack', getHeaders: '<REDACTED>' })
  })

  it('getState() omits getHeaders when not provided', async () => {
    const r = new SlackResource({ proxyUrl: '/api/slack' })
    const state = await r.getState()
    expect(state.config).toEqual({ proxyUrl: '/api/slack' })
    expect(state.config).not.toHaveProperty('getHeaders')
  })

  it('readdir(/channels/) calls proxyUrl-prefixed conversations.list', async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const u = url instanceof URL ? url.href : url instanceof Request ? url.url : url
      if (u.includes('conversations.list')) {
        return Promise.resolve(
          jsonResponse({
            ok: true,
            channels: [
              { id: 'C1', name: 'general', created: 1700000000 },
              { id: 'C2', name: 'eng', created: 1700001000 },
            ],
            response_metadata: { next_cursor: '' },
          }),
        )
      }
      return Promise.resolve(jsonResponse({ ok: true }))
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const r = new SlackResource({ proxyUrl: '/api/slack' })
    const out = await r.readdir(
      new PathSpec({
        original: '/mnt/slack/channels',
        directory: '/mnt/slack/channels',
        prefix: '/mnt/slack',
      }),
    )
    expect(out).toEqual(['/mnt/slack/channels/general__C1', '/mnt/slack/channels/eng__C2'])
    expect(fetchMock).toHaveBeenCalled()
    const firstArg = (fetchMock.mock.calls[0] as unknown[])[0]
    const firstUrl =
      firstArg instanceof URL
        ? firstArg.href
        : firstArg instanceof Request
          ? firstArg.url
          : String(firstArg)
    expect(firstUrl).toContain('/api/slack/conversations.list')
    expect(firstUrl).not.toContain('slack.com')
  })
})

describe('redactSlackConfig (browser)', () => {
  it('keeps proxyUrl in clear, redacts getHeaders only when present', () => {
    expect(redactSlackConfig({ proxyUrl: '/p' })).toEqual({ proxyUrl: '/p' })
    const headers = (): Record<string, string> => ({})
    expect(redactSlackConfig({ proxyUrl: '/p', getHeaders: headers })).toEqual({
      proxyUrl: '/p',
      getHeaders: '<REDACTED>',
    })
  })
})

describe('browser registry: slack', () => {
  it('builds slack resource with proxyUrl', async () => {
    const r = await buildResource('slack', { proxyUrl: '/api/slack' })
    expect(r.kind).toBe(ResourceName.SLACK)
    expect(r).toBeInstanceOf(SlackResource)
  })

  it('builds slack resource with proxyUrl and getHeaders', async () => {
    const headers = (): Record<string, string> => ({ 'X-Auth': 'x' })
    const r = (await buildResource('slack', {
      proxyUrl: '/api/slack',
      getHeaders: headers,
    })) as SlackResource
    expect(r.kind).toBe(ResourceName.SLACK)
    expect(r.config.proxyUrl).toBe('/api/slack')
    expect(r.config.getHeaders).toBe(headers)
  })
})
