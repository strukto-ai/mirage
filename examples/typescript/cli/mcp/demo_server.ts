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

import { writeFileSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'

import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

// A deterministic MCP server over stdio, so the converters run without
// credentials or network access. Its tools cover a flat input, a nested
// input, a tool that reports an error and a slow write to cancel.
const server = new McpServer({ name: 'demo', version: '1.0.0' })

server.registerTool(
  'add_numbers',
  {
    description: 'Add two integers.',
    inputSchema: z.object({ a: z.number().int(), b: z.number().int() }),
    annotations: { readOnlyHint: true },
  },
  ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
)

server.registerTool(
  'create_ticket',
  {
    description: 'Create a ticket owned by one person.',
    inputSchema: z.object({
      title: z.string(),
      labels: z.array(z.string()),
      owner: z.object({ name: z.string(), email: z.string() }),
    }),
  },
  ({ title, labels, owner }) => ({
    content: [
      {
        type: 'text',
        text: `${title} [${labels.join(', ') || 'none'}] owned by ${owner.name} <${owner.email}>`,
      },
    ],
  }),
)

server.registerTool(
  'delete_project',
  {
    description: 'Delete a project. This demo refuses every project.',
    inputSchema: z.object({ project: z.string() }),
    annotations: { destructiveHint: true },
  },
  ({ project }) => {
    throw new Error(`project ${project} is protected`)
  },
)

server.registerTool(
  'slow_write',
  {
    description: 'Write PATH.started, then PATH two seconds later.',
    inputSchema: z.object({ path: z.string() }),
  },
  async ({ path }) => {
    writeFileSync(`${path}.started`, '')
    await setTimeout(2000)
    writeFileSync(path, '')
    return { content: [{ type: 'text', text: path }] }
  },
)

// A stdio server exits when its client closes stdin, as Python's SDK does.
process.stdin.on('end', () => process.exit(0))
await server.connect(new StdioServerTransport())
