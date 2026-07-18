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

import { PathSpec, ResourceName, SLACK_COMMANDS, SLACK_OPS, mountKey } from '@struktoai/mirage-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildResource } from '../registry.ts'
import { normalizeSlackConfig, redactSlackConfig } from './config.ts'
import { SlackResource } from './slack.ts'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  })
}

describe('SlackResource (node)', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse({ ok: true })),
    ) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('constructs with token and exposes expected fields', () => {
    const r = new SlackResource({ token: 'xoxb-test' })
    expect(r.kind).toBe(ResourceName.SLACK)
    expect(r.cachesReads).toBe(true)
    expect(r.indexTtl).toBe(600)
    expect(r.config).toEqual({ token: 'xoxb-test' })
    expect(typeof r.prompt).toBe('string')
    expect(typeof r.writePrompt).toBe('string')
  })

  it('commands() returns SLACK_COMMANDS', () => {
    const r = new SlackResource({ token: 'xoxb-test' })
    expect(r.commands()).toBe(SLACK_COMMANDS)
  })

  it('ops() returns SLACK_OPS', () => {
    const r = new SlackResource({ token: 'xoxb-test' })
    expect(r.ops()).toBe(SLACK_OPS)
  })

  it('getState() redacts both token and searchToken when both present', async () => {
    const r = new SlackResource({ token: 'xoxb-x', searchToken: 'xoxp-y' })
    const state = await r.getState()
    expect(state.type).toBe(ResourceName.SLACK)
    expect(state).not.toHaveProperty('needsOverride')
    expect(state).not.toHaveProperty('redactedFields')
    expect(state.config).toEqual({ token: '<REDACTED>', searchToken: '<REDACTED>' })
  })

  it('getState() omits searchToken when not provided', async () => {
    const r = new SlackResource({ token: 'xoxb-x' })
    const state = await r.getState()
    expect(state.config).toEqual({ token: '<REDACTED>' })
    expect(state.config).not.toHaveProperty('searchToken')
  })

  it('readdir(/channels/) calls conversations.list and returns names', async () => {
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
    const r = new SlackResource({ token: 'xoxb-test' })
    const out = await r.readdir(
      new PathSpec({
        virtual: '/mnt/slack/channels',
        directory: '/mnt/slack/channels',
        resourcePath: mountKey('/mnt/slack/channels', '/mnt/slack'),
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
    expect(firstUrl).toContain('conversations.list')
    expect(firstUrl).toContain('slack.com/api')
  })
})

describe('redactSlackConfig (node)', () => {
  it('redacts only declared fields, drops nothing else', () => {
    expect(redactSlackConfig({ token: 'a' })).toEqual({ token: '<REDACTED>' })
    expect(redactSlackConfig({ token: 'a', searchToken: 'b' })).toEqual({
      token: '<REDACTED>',
      searchToken: '<REDACTED>',
    })
  })
})

describe('normalizeSlackConfig', () => {
  it('renames search_token to searchToken', () => {
    expect(normalizeSlackConfig({ token: 'a', search_token: 'b' })).toEqual({
      token: 'a',
      searchToken: 'b',
    })
  })

  it('passes camelCase through unchanged', () => {
    expect(normalizeSlackConfig({ token: 'a', searchToken: 'b' })).toEqual({
      token: 'a',
      searchToken: 'b',
    })
  })

  it('omits searchToken when not provided', () => {
    expect(normalizeSlackConfig({ token: 'a' })).toEqual({ token: 'a' })
  })
})

describe('node registry: slack', () => {
  it('builds slack resource with token (camelCase)', async () => {
    const r = await buildResource('slack', { token: 'xoxb-x' })
    expect(r.kind).toBe(ResourceName.SLACK)
    expect(r).toBeInstanceOf(SlackResource)
  })

  it('builds slack resource with snake_case search_token', async () => {
    const r = (await buildResource('slack', {
      token: 'xoxb-x',
      search_token: 'xoxp-y',
    })) as SlackResource
    expect(r.kind).toBe(ResourceName.SLACK)
    expect(r.config).toEqual({ token: 'xoxb-x', searchToken: 'xoxp-y' })
  })
})
