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

import type { Tool } from '@modelcontextprotocol/client'
import { MCPAccessor } from '../../../accessor/mcp.ts'
import { MCPConfig, parseMCPConfig } from '../../../core/mcp/config.ts'
import { compactJsonText } from '../../../core/render/json.ts'
import type { JsonValue } from '../../../types.ts'
import { Argument, CommandSpec } from '../../spec/types.ts'
import { CLI, CLIHandler, type CLIVerbFn } from '../types.ts'
import { callTool, causes, commandName } from './call.ts'
import { NAME } from './constants.ts'
import { MCPToolsError } from './errors.ts'
import type { MCPSource, MCPTool } from './types.ts'

/**
 * Refuse a tool list no CLI can be made from: no tools, a name that reads
 * as an option, or two names that become the same subcommand.
 */
export function checkNames(tools: readonly MCPTool[]): void {
  if (tools.length === 0) throw new MCPToolsError('the server lists no tools')
  const seen = new Map<string, string>()
  for (const tool of tools) {
    const command = commandName(tool.name)
    if (command.startsWith('-')) {
      throw new MCPToolsError(`tool '${tool.name}' would become the option '${command}'`)
    }
    const first = seen.get(command)
    if (first !== undefined) {
      throw new MCPToolsError(`tools '${first}' and '${tool.name}' both become '${command}'`)
    }
    seen.set(command, tool.name)
  }
}

/** One tool's subcommand: its first line, the rest and its compact schema. */
export function leaf(tool: MCPTool): CommandSpec {
  const description = tool.description.trim()
  const cut = description.indexOf('\n')
  const first = cut === -1 ? description : description.slice(0, cut)
  const rest = cut === -1 ? '' : description.slice(cut + 1)
  return new CommandSpec({
    name: commandName(tool.name),
    description: first,
    epilog:
      `${rest.trim()}\n\nJSON arguments (schema):\n${compactJsonText(tool.inputSchema)}`.trimStart(),
    arguments: [new Argument('JSON', { nargs: '?', help: "the tool's arguments as one object" })],
  })
}

/** The CLI an MCP server's tool list becomes, one subcommand a tool. Throws MCPToolsError. */
export function buildCli(source: MCPSource): CLI {
  checkNames(source.tools)
  return new CLI({
    spec: new CommandSpec({
      name: NAME,
      description: source.title,
      subcommands: source.tools.map(leaf),
    }),
    handlers: Object.fromEntries(
      source.tools.map((tool) => {
        const fn: CLIVerbFn<MCPAccessor> = (accessor, paths, texts, ctx) =>
          callTool(tool.name, accessor, paths, texts, ctx)
        return [
          commandName(tool.name),
          new CLIHandler({ fn, write: tool.annotations.readOnlyHint !== true }),
        ]
      }),
    ),
    configModel: MCPConfig,
    accessor: (config) => new MCPAccessor(config as MCPConfig),
    mcp: source,
  })
}

/**
 * Read a streamable-HTTP MCP server's tools and build its CLI. Install it
 * with `ws.registerCli(name, cli, config)`.
 *
 * Throws MCPToolsError when the server cannot be listed or its tools
 * cannot be made into a CLI, and ZodError for a config MCPConfig refuses.
 */
export async function mcpCli(config: MCPConfig | Record<string, unknown>): Promise<CLI> {
  const validated = parseMCPConfig(config as Record<string, unknown>)
  let listed: [string, Tool[]]
  try {
    listed = await new MCPAccessor(validated).listTools()
  } catch (error) {
    throw new MCPToolsError(`cannot list the server's tools: ${causes(error).join('; ')}`, {
      cause: error,
    })
  }
  const [title, tools] = listed
  return buildCli({
    title,
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema as Record<string, JsonValue>,
      annotations: (tool.annotations ?? {}) as Record<string, JsonValue>,
    })),
  })
}
