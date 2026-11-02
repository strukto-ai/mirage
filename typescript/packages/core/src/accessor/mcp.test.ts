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

import {
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  ProtocolError,
} from '@modelcontextprotocol/client'
import { describe, expect, it, vi } from 'vitest'
import {
  bearerConfig,
  API_KEY,
  expire,
  type FakeMCP,
  opens,
  servedMcp,
} from '../../tests/fixtures/mcp_server.ts'
import { mcpCli } from '../commands/cli/mcp/index.ts'
import { MCPConfig } from '../core/mcp/config.ts'
import { parseConfigWithSchema } from '../vfs/secrets.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { Workspace } from '../workspace/workspace/workspace.ts'
import { answered, MCPAccessor, TIMEOUT } from './mcp.ts'

describe('MCPAccessor', () => {
  it.each([
    [{ type: 'bearer', token: 't' }, { Authorization: 'Bearer t' }],
    [{ type: 'header', name: 'x-api-key', token: 't' }, { 'x-api-key': 't' }],
    [undefined, {}],
  ])('turns auth %j into one header', (auth, headers) => {
    const config = parseConfigWithSchema(MCPConfig, {
      url: 'http://x/mcp',
      ...(auth === undefined ? {} : { auth }),
    })
    expect(new MCPAccessor(config).headers()).toEqual(headers)
  })

  it('carries the header on list and call', async () => {
    const fake = await servedMcp()
    const config = { url: fake.url, auth: { type: 'header', name: 'x-api-key', token: API_KEY } }
    const ws = new Workspace({ '/data': new RAMVFS() })
    try {
      ws.registerCli('fx', await mcpCli(config), config)
      const listed = fake.requests.length
      const result = await ws.shell('fx list-items')
      expect(result.exitCode).toBe(0)
      expect(listed).toBeGreaterThan(0)
      expect(fake.requests.length).toBeGreaterThan(listed)
      expect(new Set(fake.requests.map((r) => r['x-api-key']))).toEqual(new Set([API_KEY]))
      expect(new Set(fake.requests.map((r) => r.authorization))).toEqual(new Set(['']))
    } finally {
      await ws.close()
      await fake.close()
    }
  })

  async function kept(use: (ws: Workspace, fake: FakeMCP) => Promise<void>): Promise<FakeMCP> {
    const fake = await servedMcp()
    const config = bearerConfig(fake)
    const ws = new Workspace({ '/data': new RAMVFS() })
    try {
      ws.registerCli('fx', await mcpCli(config), config)
      fake.requests.length = 0
      await use(ws, fake)
    } finally {
      await ws.close()
      await fake.close()
    }
    return fake
  }

  it('shares one client across calls', async () => {
    const fake = await kept(async (ws) => {
      for (let i = 0; i < 3; i++) expect((await ws.shell('fx list-items')).exitCode).toBe(0)
    })
    expect(opens(fake)).toBe(1)
  })

  it('drops the client on a failed call and reopens it on the next', async () => {
    const fake = await kept(async (ws, fake) => {
      expect((await ws.shell('fx list-items')).exitCode).toBe(0)
      expire(fake)
      expect((await ws.shell('fx list-items')).exitCode).toBe(1)
      expect((await ws.shell('fx list-items')).exitCode).toBe(0)
    })
    expect(opens(fake)).toBe(2)
  })

  it('follows a failed open with a successful call', async () => {
    await kept(async (ws, fake) => {
      fake.down = true
      expect((await ws.shell('fx list-items')).exitCode).toBe(1)
      fake.down = false
      expect((await ws.shell('fx list-items')).exitCode).toBe(0)
    })
  })

  it('keeps the client on an error the server answered', async () => {
    const fake = await kept(async (ws) => {
      expect((await ws.shell('fx list-items')).exitCode).toBe(0)
      const accessor = ws.clis().get('fx')?.accessor as MCPAccessor
      await expect(accessor.callTool('no_tool', {})).rejects.toThrow(/no tool/)
      expect((await ws.shell('fx list-items')).exitCode).toBe(0)
    })
    expect(opens(fake)).toBe(1)
  })

  it('lets a call go while its client is still opening', async () => {
    const fake = await servedMcp()
    fake.stalling = true
    const config = bearerConfig(fake)
    const accessor = new MCPAccessor(parseConfigWithSchema(MCPConfig, config))
    const abort = new AbortController()
    const call = accessor.callTool('list_items', {}, abort.signal)
    abort.abort()
    await expect(call).rejects.toMatchObject({ name: 'AbortError' })
    await fake.close()
    await accessor.close()
  })

  it.each([
    [new ProtocolError(INVALID_PARAMS, 'x'), true],
    [new ProtocolError(METHOD_NOT_FOUND, 'x'), true],
    [new ProtocolError(5, 'x'), true],
    [new ProtocolError(-32001, 'x'), false],
    [new ProtocolError(-32000, 'x'), false],
    [new ProtocolError(INVALID_REQUEST, 'x'), false],
    [new Error('x'), false],
  ])('keeps the client only for an error the server answered: %s', async (error, kept) => {
    expect(await answered(error)).toBe(kept)
  })

  it('joins a dropped client still closing when it closes', async () => {
    const fake = await servedMcp()
    const accessor = new MCPAccessor(parseConfigWithSchema(MCPConfig, bearerConfig(fake)))
    try {
      const held = accessor.callTool('echo_args', { delay: 300 })
      for (let i = 0; i < 500 && fake.started.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      fake.down = true
      await expect(accessor.callTool('list_items', {})).rejects.toThrow()
      fake.down = false
      fake.stalling = true
      await held
      let closed = false
      const closing = accessor.close().then(() => {
        closed = true
      })
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(closed).toBe(false)
      await fake.close()
      await closing
    } finally {
      await fake.close()
    }
  })

  it('cuts a session end the server never answers off after the call timeout', async () => {
    const fake = await servedMcp()
    const accessor = new MCPAccessor(parseConfigWithSchema(MCPConfig, bearerConfig(fake)))
    try {
      await accessor.callTool('list_items', {})
      fake.stalling = true
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const closing = accessor.close()
      await vi.waitFor(() => {
        expect(fake.requests.map((r) => r.method)).toContain('DELETE')
      })
      await vi.advanceTimersByTimeAsync(TIMEOUT)
      await closing
    } finally {
      vi.useRealTimers()
      await fake.close()
    }
  })

  it('closes the client when the CLI is removed', async () => {
    await kept(async (ws, fake) => {
      expect((await ws.shell('fx list-items')).exitCode).toBe(0)
      expect(fake.requests.map((r) => r.method)).not.toContain('DELETE')
      await ws.unregisterCli('fx')
      expect(fake.requests.map((r) => r.method).at(-1)).toBe('DELETE')
    })
  })

  it('lets the calls in flight on a dropped client run on', async () => {
    const fake = await kept(async (ws, fake) => {
      ws.createSession('other')
      let done = false
      const line = ws.shell('fx wait-forever').finally(() => {
        done = true
      })
      for (let i = 0; i < 500 && fake.started.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      fake.down = true
      expect((await ws.shell('fx list-items', { sessionId: 'other' })).exitCode).toBe(1)
      fake.down = false
      expect((await ws.shell('fx list-items', { sessionId: 'other' })).exitCode).toBe(0)
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(done).toBe(false)
      expect(fake.requests.map((r) => r.method)).not.toContain('DELETE')
      await ws.cancel()
      await expect(line).rejects.toMatchObject({ name: 'AbortError' })
      const deletes = (): number => fake.requests.filter((r) => r.method === 'DELETE').length
      for (let i = 0; i < 500 && deletes() === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(deletes()).toBe(1)
    })
    expect(opens(fake)).toBe(2)
  })

  it('answers the last call on a dropped client without waiting for its close', async () => {
    await kept(async (ws, fake) => {
      ws.createSession('other')
      const line = ws.shell(`fx echo-args '{"delay": 1000}'`)
      for (let i = 0; i < 500 && fake.started.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      fake.down = true
      expect((await ws.shell('fx list-items', { sessionId: 'other' })).exitCode).toBe(1)
      fake.down = false
      fake.stalling = true
      expect((await line).exitCode).toBe(0)
      fake.stalling = false
    })
  })

  it('keeps the client open when a call is cancelled', async () => {
    const fake = await kept(async (ws, fake) => {
      const line = ws.shell('fx wait-forever')
      for (let i = 0; i < 500 && fake.started.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      await ws.cancel()
      await expect(line).rejects.toMatchObject({ name: 'AbortError' })
      expect((await ws.shell('fx list-items')).exitCode).toBe(0)
      for (let i = 0; i < 500 && fake.cancelled.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    })
    expect(opens(fake)).toBe(1)
    expect(fake.cancelled).toEqual(['wait_forever'])
  })
})
