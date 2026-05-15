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

import { MountMode } from '@struktoai/mirage-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Workspace } from '../../workspace.ts'
import { SlackResource } from './slack.ts'

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

describe('SlackResource integration', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse({ ok: true })),
    ) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('ls /slack/channels/ returns channel directory names', async () => {
    globalThis.fetch = vi.fn((url: string | URL | Request) => {
      const u = urlOf(url)
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
    }) as unknown as typeof fetch

    const slack = new SlackResource({ token: 'xoxb-test' })
    const ws = new Workspace({ '/slack': slack }, { mode: MountMode.READ })
    try {
      const result = await ws.execute('ls /slack/channels/')
      if (result.exitCode !== 0) {
        throw new Error(`ls failed: ${result.stderrText} | stdout: ${result.stdoutText}`)
      }
      const out = result.stdoutText
      expect(out).toContain('general__C1')
      expect(out).toContain('eng__C2')
    } finally {
      await ws.close()
    }
  })

  it('cat reads jsonl history for a channel/date', async () => {
    const created = Date.UTC(2024, 0, 1) / 1000
    const latest = Date.UTC(2024, 0, 1, 12) / 1000
    globalThis.fetch = vi.fn((url: string | URL | Request) => {
      const u = urlOf(url)
      if (u.includes('conversations.list')) {
        return Promise.resolve(
          jsonResponse({
            ok: true,
            channels: [{ id: 'C1', name: 'general', created }],
            response_metadata: { next_cursor: '' },
          }),
        )
      }
      if (u.includes('conversations.history')) {
        if (u.includes('limit=1')) {
          return Promise.resolve(jsonResponse({ ok: true, messages: [{ ts: String(latest) }] }))
        }
        return Promise.resolve(
          jsonResponse({
            ok: true,
            messages: [
              { ts: String(latest - 30), user: 'U1', text: 'first' },
              { ts: String(latest), user: 'U2', text: 'second' },
            ],
            has_more: false,
          }),
        )
      }
      return Promise.resolve(jsonResponse({ ok: true }))
    }) as unknown as typeof fetch

    const slack = new SlackResource({ token: 'xoxb-test' })
    const ws = new Workspace({ '/slack': slack }, { mode: MountMode.READ })
    try {
      const ls = await ws.execute('ls /slack/channels/general__C1/')
      if (ls.exitCode !== 0) {
        throw new Error(`ls failed: ${ls.stderrText} | stdout: ${ls.stdoutText}`)
      }
      expect(ls.stdoutText).toContain('2024-01-01')
      const cat = await ws.execute('cat /slack/channels/general__C1/2024-01-01/chat.jsonl')
      expect(cat.exitCode).toBe(0)
      const lines = cat.stdoutText
        .trim()
        .split('\n')
        .filter((l) => l !== '')
      expect(lines).toHaveLength(2)
      const first = JSON.parse(lines[0] ?? '{}') as { user?: string; text?: string }
      const second = JSON.parse(lines[1] ?? '{}') as { user?: string; text?: string }
      expect(first.text).toBe('first')
      expect(second.text).toBe('second')
    } finally {
      await ws.close()
    }
  })

  it('slack-get-users command returns filtered users', async () => {
    globalThis.fetch = vi.fn((url: string | URL | Request) => {
      const u = urlOf(url)
      if (u.includes('users.list')) {
        return Promise.resolve(
          jsonResponse({
            ok: true,
            members: [
              { id: 'U1', name: 'alice', real_name: 'Alice Liddell' },
              { id: 'U2', name: 'bob', real_name: 'Bob Jones' },
              { id: 'U3', name: 'carol', real_name: 'Carol Smith' },
            ],
          }),
        )
      }
      return Promise.resolve(jsonResponse({ ok: true }))
    }) as unknown as typeof fetch

    const slack = new SlackResource({ token: 'xoxb-test' })
    const ws = new Workspace({ '/slack': slack }, { mode: MountMode.READ })
    try {
      const result = await ws.execute('slack-get-users --query alice')
      expect(result.exitCode).toBe(0)
      const users = JSON.parse(result.stdoutText) as { id: string; name: string }[]
      expect(users).toHaveLength(1)
      expect(users[0]?.name).toBe('alice')
    } finally {
      await ws.close()
    }
  })
})
