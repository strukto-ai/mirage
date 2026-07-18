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

import { mountKey } from '@struktoai/mirage-core'
import { PathSpec, ResourceName, TRELLO_OPS } from '@struktoai/mirage-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildResource } from '../registry.ts'
import { redactTrelloConfig } from './config.ts'
import { TrelloResource } from './trello.ts'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  })
}

describe('TrelloResource (browser)', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse([]))) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('constructs with apiKey/apiToken and exposes expected fields', () => {
    const r = new TrelloResource({ apiKey: 'k', apiToken: 't' })
    expect(r.kind).toBe(ResourceName.TRELLO)
    expect(r.cachesReads).toBe(true)
    expect(r.indexTtl).toBe(600)
    expect(r.config).toEqual({ apiKey: 'k', apiToken: 't' })
    expect(typeof r.prompt).toBe('string')
    expect(typeof r.writePrompt).toBe('string')
  })

  it('ops() returns TRELLO_OPS', () => {
    const r = new TrelloResource({ apiKey: 'k', apiToken: 't' })
    expect(r.ops()).toBe(TRELLO_OPS)
  })

  it('getState() redacts apiKey/apiToken', async () => {
    const r = new TrelloResource({ apiKey: 'k', apiToken: 't', workspaceId: 'w1' })
    const state = await r.getState()
    expect(state.type).toBe(ResourceName.TRELLO)
    expect(state).not.toHaveProperty('needsOverride')
    expect(state).not.toHaveProperty('redactedFields')
    expect(state.config).toEqual({
      apiKey: '<REDACTED>',
      apiToken: '<REDACTED>',
      workspaceId: 'w1',
    })
  })

  it('readdir(/workspaces) calls api.trello.com directly with key+token in URL', async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const u = url instanceof URL ? url.href : url instanceof Request ? url.url : url
      if (u.includes('/members/me/organizations')) {
        return Promise.resolve(
          jsonResponse([
            { id: 'w1', displayName: 'Acme' },
            { id: 'w2', displayName: 'Beta' },
          ]),
        )
      }
      return Promise.resolve(jsonResponse([]))
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const r = new TrelloResource({ apiKey: 'KEY', apiToken: 'TOK' })
    const out = await r.readdir(
      new PathSpec({
        virtual: '/mnt/trello/workspaces',
        directory: '/mnt/trello/workspaces',
        resourcePath: mountKey('/mnt/trello/workspaces', '/mnt/trello'),
      }),
    )
    expect(out).toEqual(['/mnt/trello/workspaces/Acme__w1', '/mnt/trello/workspaces/Beta__w2'])
    expect(fetchMock).toHaveBeenCalled()
    const firstArg = (fetchMock.mock.calls[0] as unknown[])[0]
    const firstUrl =
      firstArg instanceof URL
        ? firstArg.href
        : firstArg instanceof Request
          ? firstArg.url
          : String(firstArg)
    expect(firstUrl).toContain('https://api.trello.com/1/members/me/organizations')
    expect(firstUrl).toContain('key=KEY')
    expect(firstUrl).toContain('token=TOK')
  })

  it('honors custom baseUrl override', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse([])))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const r = new TrelloResource({
      apiKey: 'k',
      apiToken: 't',
      baseUrl: 'https://my.proxy.example/trello',
    })
    await r.readdir(
      new PathSpec({
        virtual: '/mnt/trello/workspaces',
        directory: '/mnt/trello/workspaces',
        resourcePath: mountKey('/mnt/trello/workspaces', '/mnt/trello'),
      }),
    )
    const firstArg = (fetchMock.mock.calls[0] as unknown[])[0]
    const firstUrl =
      firstArg instanceof URL
        ? firstArg.href
        : firstArg instanceof Request
          ? firstArg.url
          : String(firstArg)
    expect(firstUrl).toContain('https://my.proxy.example/trello/members/me/organizations')
    expect(firstUrl).not.toContain('api.trello.com')
  })

  it('applies workspaceId filter', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        jsonResponse([
          { id: 'w1', displayName: 'Acme' },
          { id: 'w2', displayName: 'Beta' },
        ]),
      ),
    ) as unknown as typeof fetch
    const r = new TrelloResource({ apiKey: 'k', apiToken: 't', workspaceId: 'w2' })
    const out = await r.readdir(
      new PathSpec({
        virtual: '/mnt/trello/workspaces',
        directory: '/mnt/trello/workspaces',
        resourcePath: mountKey('/mnt/trello/workspaces', '/mnt/trello'),
      }),
    )
    expect(out).toEqual(['/mnt/trello/workspaces/Beta__w2'])
  })
})

describe('redactTrelloConfig (browser)', () => {
  it('redacts apiKey/apiToken, keeps workspace metadata', () => {
    expect(redactTrelloConfig({ apiKey: 'k', apiToken: 't' })).toEqual({
      apiKey: '<REDACTED>',
      apiToken: '<REDACTED>',
    })
    expect(
      redactTrelloConfig({
        apiKey: 'k',
        apiToken: 't',
        workspaceId: 'w1',
        boardIds: ['b1'],
        baseUrl: 'https://x',
      }),
    ).toEqual({
      apiKey: '<REDACTED>',
      apiToken: '<REDACTED>',
      workspaceId: 'w1',
      boardIds: ['b1'],
      baseUrl: 'https://x',
    })
  })
})

describe('browser registry: trello', () => {
  it('builds trello resource with apiKey/apiToken', async () => {
    const r = await buildResource('trello', { apiKey: 'k', apiToken: 't' })
    expect(r.kind).toBe(ResourceName.TRELLO)
    expect(r).toBeInstanceOf(TrelloResource)
  })

  it('accepts snake_case config (api_key, api_token, workspace_id, board_ids)', async () => {
    const r = (await buildResource('trello', {
      api_key: 'k',
      api_token: 't',
      workspace_id: 'w1',
      board_ids: ['b1', 'b2'],
    })) as TrelloResource
    expect(r.config.apiKey).toBe('k')
    expect(r.config.apiToken).toBe('t')
    expect(r.config.workspaceId).toBe('w1')
    expect(r.config.boardIds).toEqual(['b1', 'b2'])
  })
})
