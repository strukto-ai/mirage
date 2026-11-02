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

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bearerConfig,
  type FakeMCP,
  opens,
  servedMcp,
  TOKEN,
} from '../../../../tests/fixtures/mcp_server.ts'
import type * as constants from '../../../core/mcp/constants.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { render } from './call.ts'
import { mcpCli } from './index.ts'

const limits = vi.hoisted(() => ({ timeout: 0 }))

vi.mock('../../../core/mcp/constants.ts', async (importOriginal) => {
  const real = await importOriginal<typeof constants>()
  return {
    ...real,
    get TIMEOUT() {
      return limits.timeout || real.TIMEOUT
    },
  }
})

const opened: { ws: Workspace; fake: FakeMCP }[] = []

async function installed(): Promise<{ ws: Workspace; fake: FakeMCP }> {
  const fake = await servedMcp()
  const config = bearerConfig(fake)
  const ws = new Workspace({ '/data': new RAMVFS() })
  ws.registerCli('fx', await mcpCli(config), config)
  opened.push({ ws, fake })
  return { ws, fake }
}

afterEach(async () => {
  limits.timeout = 0
  for (const { ws, fake } of opened.splice(0)) {
    await ws.close()
    await fake.close()
  }
})

describe('an MCP tool call', () => {
  it('passes the arguments verbatim', async () => {
    const { ws } = await installed()
    const result = await ws.shell(`fx echo-args '{"b": 1, "a": [1, 2]}'`)
    const empty = await ws.shell('fx echo-args')
    expect([result.exitCode, result.stdoutText]).toEqual([0, '{"a": [1, 2], "b": 1}\n'])
    expect(empty.stdoutText).toBe('{}\n')
  })

  it('prints text blocks as text', async () => {
    const { ws } = await installed()
    expect((await ws.shell('fx list-items')).stdoutText).toBe('apple\nbanana\n')
  })

  it.each([
    ["'{nope'", 'echo-args: invalid JSON\n'],
    ["'[1]'", 'echo-args: JSON must be an object\n'],
    ["'null'", 'echo-args: JSON must be an object\n'],
    ["'{}' '{}'", 'echo-args: takes one JSON object\n'],
  ])('exits 2 for operands that are not one JSON object (%s)', async (operands, stderr) => {
    const { ws, fake } = await installed()
    const before = fake.requests.length
    const result = await ws.shell(`fx echo-args ${operands}`)
    expect([result.exitCode, result.stderrText]).toEqual([2, stderr])
    expect(fake.requests.length).toBe(before)
  })

  it('exits 1 with the text on stderr for a tool error', async () => {
    const { ws } = await installed()
    const result = await ws.shell('fx fail-always')
    expect([result.exitCode, result.stdoutText, result.stderrText]).toEqual([1, '', 'boom\n'])
  })

  it('says a tool error that has no text', async () => {
    const { ws } = await installed()
    const result = await ws.shell(`fx fail-always '{"quiet": true}'`)
    expect([result.exitCode, result.stderrText]).toEqual([
      1,
      'fail-always: the tool reported an error\n',
    ])
  })

  it('exits 1 without the token when the server is gone', async () => {
    const fake = await servedMcp()
    const config = bearerConfig(fake)
    const cli = await mcpCli(config)
    await fake.close()
    const ws = new Workspace({ '/data': new RAMVFS() })
    ws.registerCli('fx', cli, config)
    try {
      const result = await ws.shell('fx list-items')
      expect(result.exitCode).toBe(1)
      expect(result.stderrText.startsWith('list-items: MCP server failed: ')).toBe(true)
      expect(result.stderrText).not.toContain(TOKEN)
    } finally {
      await ws.close()
    }
  })

  it('exits 1 and says so for a call past the timeout, dropping the client', async () => {
    const { ws, fake } = await installed()
    limits.timeout = 1
    const result = await ws.shell('fx wait-forever')
    expect([result.exitCode, result.stderrText]).toEqual([
      1,
      'wait-forever: MCP server timed out\n',
    ])
    const before = opens(fake)
    expect((await ws.shell('fx list-items')).stdoutText).toBe('apple\nbanana\n')
    expect(opens(fake)).toBe(before + 1)
  })

  it('exits 1 and says so for a server that never opens a session', async () => {
    const { ws, fake } = await installed()
    limits.timeout = 1
    fake.stalling = true
    const result = await ws.shell('fx list-items')
    expect([result.exitCode, result.stderrText]).toEqual([1, 'list-items: MCP server timed out\n'])
  })
})

describe('render', () => {
  const text = (value: string) => ({ type: 'text' as const, text: value })
  it.each([
    [[], undefined, ''],
    [[text('a\n')], undefined, 'a\n'],
    [[text('a'), text('b')], undefined, 'a\nb\n'],
    [[text('a')], { n: 1 }, 'a\n'],
    [[], { n: 1 }, '{"n":1}\n'],
    [
      [{ type: 'image' as const, data: 'AA==', mimeType: 'image/png' }],
      undefined,
      '{"type":"image","data":"AA==","mimeType":"image/png"}\n',
    ],
  ])('renders %j with structured %j', (content, structuredContent, out) => {
    expect(render({ content, ...(structuredContent ? { structuredContent } : {}) })).toBe(out)
  })
})
