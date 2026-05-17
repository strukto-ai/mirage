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

describe('DiscordResource integration', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse([]))) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('ls /discord/ returns top-level guild directory names', async () => {
    globalThis.fetch = vi.fn((url: string | URL | Request) => {
      const u = urlOf(url)
      if (u.includes('/users/@me/guilds')) {
        return Promise.resolve(jsonResponse([{ id: 'G1', name: 'My Server' }]))
      }
      return Promise.resolve(jsonResponse([]))
    }) as unknown as typeof fetch

    const discord = new DiscordResource({ token: 'bot-test' })
    const ws = new Workspace({ '/discord': discord }, { mode: MountMode.READ })
    try {
      const result = await ws.execute('ls /discord/')
      if (result.exitCode !== 0) {
        throw new Error(`ls failed: ${result.stderrText} | stdout: ${result.stdoutText}`)
      }
      expect(result.stdoutText).toContain('My Server__G1')
    } finally {
      await ws.close()
    }
  })
})
