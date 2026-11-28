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

import { ops } from '@struktoai/mirage-core/test-utils'
import { PathSpec, VFSName } from '@struktoai/mirage-core/types'
import { parseConfigWithSchema, redactedConfigDump } from '@struktoai/mirage-core/vfs/secrets'
import { SlackConfig } from '@struktoai/mirage-core/vfs/slack/config'
import { backendCommands } from '@struktoai/mirage-core/workspace/mount/backends'
import { describe, expect, it, vi } from 'vitest'
import { buildVfs } from '../registry.ts'
import { SlackVFS } from '@struktoai/mirage-core/vfs/direct/slack'
import { serve } from '../../../../core/tests/fixtures/kit_fake.ts'
import { LISTING, SlackWorkspace } from '../../../../core/tests/fixtures/slack_workspace.ts'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  })
}

describe('SlackVFS (node)', () => {
  it('constructs with token and exposes expected fields', () => {
    const r = new SlackVFS({ token: 'xoxb-test' })
    expect(r.name).toBe(VFSName.SLACK)
    expect(r.cachesReads).toBe(true)
    expect(r.indexTtl).toBe(600)
    expect(r.config).toEqual({ token: 'xoxb-test' })
    expect(typeof r.vfsMd).toBe('string')
  })

  it('serves no commands of its own', () => {
    const r = new SlackVFS({ token: 'xoxb-test' })
    expect(backendCommands(r)).toEqual([])
  })

  it('getState() redacts both token and searchToken when both present', async () => {
    const r = new SlackVFS({ token: 'xoxb-x', searchToken: 'xoxp-y' })
    const state = await r.getState()
    expect(state.type).toBe(VFSName.SLACK)
    expect(state).not.toHaveProperty('needsOverride')
    expect(state).not.toHaveProperty('redactedFields')
    expect(state.config).toEqual({ token: '<REDACTED>', searchToken: '<REDACTED>' })
  })

  it('getState() omits searchToken when not provided', async () => {
    const r = new SlackVFS({ token: 'xoxb-x' })
    const state = await r.getState()
    expect(state.config).toEqual({ token: '<REDACTED>' })
    expect(state.config).not.toHaveProperty('searchToken')
  })

  it('readdir(/channels/) calls conversations.list and returns names', async () => {
    const workspace = new SlackWorkspace(await serve('slack'))
    try {
      await workspace.reset()
      const out = await ops(new SlackVFS(workspace.config())).readdir(
        new PathSpec({ virtual: '/channels', directory: '/channels', vfsPath: 'channels' }),
      )
      expect(out).toEqual(['/channels/general__C1', '/channels/random__C2'])
      expect(await workspace.count(LISTING)).toBe(1)
    } finally {
      await workspace.close()
    }
  })

  it('reaches slack.com/api when no base URL is set', async () => {
    // Only the URL is checked, so the answer names no channel.
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn((_url: string | URL | Request) =>
      Promise.resolve(
        jsonResponse({ ok: true, channels: [], response_metadata: { next_cursor: '' } }),
      ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    try {
      await ops(new SlackVFS({ token: 'xoxb-test' })).readdir(
        new PathSpec({ virtual: '/channels', directory: '/channels', vfsPath: 'channels' }),
      )
    } finally {
      globalThis.fetch = originalFetch
    }
    const firstArg = (fetchMock.mock.calls[0] as unknown[])[0]
    const firstUrl =
      firstArg instanceof URL
        ? firstArg.href
        : firstArg instanceof Request
          ? firstArg.url
          : String(firstArg)
    expect(firstUrl).toContain('slack.com/api/conversations.list')
  })
})

describe('SlackConfig redaction (node)', () => {
  it('redacts only declared fields, drops nothing else', () => {
    expect(redactedConfigDump(SlackConfig, { token: 'a' })).toEqual({
      token: '<REDACTED>',
    })
    expect(redactedConfigDump(SlackConfig, { token: 'a', searchToken: 'b' })).toEqual({
      token: '<REDACTED>',
      searchToken: '<REDACTED>',
    })
  })
})

describe('SlackConfig parsing', () => {
  it('renames search_token to searchToken', () => {
    expect(parseConfigWithSchema(SlackConfig, { token: 'a', search_token: 'b' })).toEqual({
      token: 'a',
      searchToken: 'b',
    })
  })

  it('passes camelCase through unchanged', () => {
    expect(parseConfigWithSchema(SlackConfig, { token: 'a', searchToken: 'b' })).toEqual({
      token: 'a',
      searchToken: 'b',
    })
  })

  it('omits searchToken when not provided', () => {
    expect(parseConfigWithSchema(SlackConfig, { token: 'a' })).toEqual({ token: 'a' })
  })
})

describe('node registry: slack', () => {
  it('builds slack VFS with token (camelCase)', async () => {
    const r = await buildVfs('slack', { token: 'xoxb-x' })
    expect(r.name).toBe(VFSName.SLACK)
    expect(r).toBeInstanceOf(SlackVFS)
  })

  it('builds slack VFS with snake_case search_token', async () => {
    const r = (await buildVfs('slack', {
      token: 'xoxb-x',
      search_token: 'xoxp-y',
    })) as SlackVFS
    expect(r.name).toBe(VFSName.SLACK)
    expect(r.config).toEqual({ token: 'xoxb-x', searchToken: 'xoxp-y' })
  })
})
