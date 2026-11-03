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
import { bearerConfig, servedMcp, TITLE, TOKEN } from '../../../../tests/fixtures/mcp_server.ts'
import { MCPConfig } from '../../../core/mcp/config.ts'
import type * as constants from '../../../core/mcp/constants.ts'
import { MAX_REPLY, MAX_TOOLS } from '../../../core/mcp/constants.ts'
import { buildCli, mcpCli, MCPToolsError, type MCPSource, type MCPTool } from './index.ts'

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

afterEach(() => {
  limits.timeout = 0
})

const SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string' } },
  required: ['name'],
}

function tool(name: string, readOnly = false): MCPTool {
  return {
    name,
    description: 'Add an item.\nIt lands last.',
    inputSchema: SCHEMA,
    annotations: readOnly ? { readOnlyHint: true } : {},
  }
}

const SOURCE: MCPSource = { title: 'Items', tools: [tool('list_items', true), tool('add_item')] }

describe('buildCli', () => {
  it('makes one subcommand per tool with dashes for underscores', () => {
    const cli = buildCli(SOURCE)
    expect(cli.spec.subcommands.map((s) => s.name)).toEqual(['list-items', 'add-item'])
    expect(Object.keys(cli.handlers).sort()).toEqual(['add-item', 'list-items'])
    expect(cli.spec.name).toBe('mcp')
    expect(cli.spec.description).toBe('Items')
  })

  it('gives a subcommand one optional JSON operand', () => {
    const [argument] = buildCli(SOURCE).spec.subcommands[1]?.arguments ?? []
    expect([argument?.names, argument?.nargs]).toEqual([['JSON'], '?'])
  })

  it('carries the compact schema and the long description in the help', () => {
    const leaf = buildCli(SOURCE).spec.subcommands[1]
    expect(leaf?.description).toBe('Add an item.')
    expect(leaf?.epilog).toBe(
      'It lands last.\n\nJSON arguments (schema):\n' +
        '{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}',
    )
  })

  it('follows the read-only hint for write', () => {
    const cli = buildCli(SOURCE)
    expect(cli.handlers['list-items']?.write).toBe(false)
    expect(cli.handlers['add-item']?.write).toBe(true)
  })

  it('carries its source and config model', () => {
    const cli = buildCli(SOURCE)
    expect(cli.mcp).toBe(SOURCE)
    expect(cli.configModel).toBe(MCPConfig)
  })

  it.each([
    [[], 'lists no tools'],
    [['-x'], "would become the option '-x'"],
    [['a_b', 'a-b'], "both become 'a-b'"],
  ])('refuses a tool list no CLI can be made from (%j)', (names, wording) => {
    const source = { title: 't', tools: names.map((n) => tool(n)) }
    expect(() => buildCli(source)).toThrow(MCPToolsError)
    expect(() => buildCli(source)).toThrow(wording)
  })
})

describe('a tool list past a cap', () => {
  it('refuses more tools than the cap', () => {
    const names = Array.from({ length: MAX_TOOLS + 1 }, (_, i) => `t${String(i)}`)
    expect(
      Object.keys(buildCli({ title: 't', tools: names.slice(1).map((n) => tool(n)) }).handlers),
    ).toHaveLength(MAX_TOOLS)
    expect(() => buildCli({ title: 't', tools: names.map((n) => tool(n)) })).toThrow(
      new MCPToolsError(`the server lists more than ${String(MAX_TOOLS)} tools`),
    )
  })

  it.each(['application/json', 'text/event-stream'])(
    'refuses a listing past the reply cap as %s',
    async (contentType) => {
      const fake = await servedMcp()
      try {
        fake.oversized['tools/list'] = contentType
        const error: unknown = await mcpCli(bearerConfig(fake)).catch((e: unknown) => e)
        expect(error).toBeInstanceOf(MCPToolsError)
        expect((error as Error).message).toBe(
          `cannot list the server's tools: MCP server reply exceeds ${String(MAX_REPLY)} bytes`,
        )
      } finally {
        await fake.close()
      }
    },
  )

  it('holds every page of a listing to one reply cap', async () => {
    const third = 'x'.repeat(Math.floor(MAX_REPLY / 3))
    const tools = [0, 1, 2].map((i) => ({
      name: `t${String(i)}`,
      description: third,
      inputSchema: { type: 'object' as const },
    }))
    const two = await servedMcp(tools.slice(0, 2))
    const three = await servedMcp(tools)
    try {
      expect(Object.keys((await mcpCli(bearerConfig(two))).handlers)).toHaveLength(2)
      const error: unknown = await mcpCli(bearerConfig(three)).then(
        () => null,
        (e: unknown) => e,
      )
      expect(error instanceof MCPToolsError && error.message.includes('reply exceeds')).toBe(true)
    } finally {
      await two.close()
      await three.close()
    }
  })
})

describe('mcpCli', () => {
  it('reads every page of the tool list', async () => {
    const fake = await servedMcp()
    try {
      const cli = await mcpCli(bearerConfig(fake))
      expect(cli.spec.subcommands.map((s) => s.name)).toEqual([
        'list-items',
        'add-item',
        'fail-always',
        'wait-forever',
        'echo-args',
      ])
      expect(cli.spec.description).toBe(TITLE)
      expect(cli.handlers['list-items']?.write).toBe(false)
      expect(cli.handlers['add-item']?.write).toBe(true)
    } finally {
      await fake.close()
    }
  })

  it('reads a tool list to 64 pages and no further', async () => {
    const fake = await servedMcp()
    const config = bearerConfig(fake)
    try {
      fake.pages = 64
      expect((await mcpCli(config)).spec.subcommands).toHaveLength(5)
      fake.pages = 65
      await expect(mcpCli(config)).rejects.toThrow(/64/)
    } finally {
      await fake.close()
    }
  })

  it('gives a tool listing one deadline across its pages', async () => {
    const fake = await servedMcp()
    try {
      limits.timeout = 1
      fake.pages = 5
      fake.pageDelay = 400
      const error: unknown = await mcpCli(bearerConfig(fake)).then(
        () => null,
        (e: unknown) => e,
      )
      expect(error).toBeInstanceOf(MCPToolsError)
      expect((error as Error).message).toBe("cannot list the server's tools: MCP server timed out")
    } finally {
      await fake.close()
    }
  })

  it('never repeats the token when a listing is refused', async () => {
    const fake = await servedMcp()
    try {
      const error: unknown = await mcpCli({
        url: fake.url,
        auth: { type: 'bearer', token: 's3cr3t-x' },
      }).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(MCPToolsError)
      expect((error as Error).message).toContain("cannot list the server's tools: ")
      expect((error as Error).message).not.toContain('s3cr3t-x')
    } finally {
      await fake.close()
    }
  })

  it('refuses a config MCPConfig refuses before any request', async () => {
    const fake = await servedMcp()
    try {
      await expect(
        mcpCli({ url: fake.url, auth: { type: 'bearer', token: TOKEN, extra: 1 } }),
      ).rejects.toThrow()
      expect(fake.requests).toEqual([])
    } finally {
      await fake.close()
    }
  })
})
