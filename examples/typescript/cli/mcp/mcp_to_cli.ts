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

import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import { Client, StreamableHTTPClientTransport, type Transport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

// Turns any MCP server into a real CLI: one subcommand per tool, named after
// the tool with dashes, taking the tool's arguments as one JSON object. The
// generated file runs on its own with node:
//
//   npx tsx mcp_to_cli.ts --name grafana --out grafana.mjs \
//       -- docker run --rm -i -e GRAFANA_URL mcp/grafana -t stdio
//   ./grafana.mjs search-dashboards '{"query": "api"}'

export type Server = { command: string[]; cwd: string | null } | { url: string }

export interface Tool {
  name: string
  description: string
  inputSchema: unknown
  annotations: Record<string, unknown>
}

/** A refusal the generator prints and exits 1 on. */
export class GenerateError extends Error {}

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/
const PLACEHOLDER = /__(NAME|NAME_LITERAL|ATTR|SERVER|TOOLS)__/g

export const TEMPLATE = readFileSync(new URL('./real_cli.mjs.tmpl', import.meta.url), 'utf8')

/** A transport to a stdio command or a streamable HTTP URL; a stdio server's own stderr lands in `log`. */
export function transport(server: Server, log: string[]): Transport {
  if ('url' in server) return new StreamableHTTPClientTransport(new URL(server.url))
  const [command = '', ...args] = server.command
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const stdio = new StdioClientTransport({
    command,
    args,
    env,
    cwd: server.cwd ?? undefined,
    stderr: 'pipe',
  })
  stdio.stderr?.on('data', (chunk: Buffer) => log.push(String(chunk)))
  return stdio
}

/** The leaf errors inside an aggregate error, one line each. */
export function causes(error: unknown): string[] {
  if (error instanceof AggregateError) return error.errors.flatMap(causes)
  if (!(error instanceof Error)) return [String(error)]
  const line = `${error.name}: ${error.message}`
  return error.cause === undefined ? [line] : [line, ...causes(error.cause)]
}

/** Read every tool the server lists, following its pages. */
export async function listTools(server: Server, log: string[]): Promise<Tool[]> {
  const client = new Client({ name: 'mcp_to_cli', version: '1.0.0' })
  try {
    await client.connect(transport(server, log))
    const tools: Tool[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor === undefined ? undefined : { cursor })
      tools.push(
        ...page.tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema,
          annotations: { ...tool.annotations },
        })),
      )
      cursor = page.nextCursor
    } while (cursor !== undefined)
    return tools
  } finally {
    await client.close()
  }
}

/** List the server's tools, showing its own log if that fails. */
export async function fetchTools(server: Server): Promise<Tool[]> {
  const log: string[] = []
  try {
    return await listTools(server, log)
  } catch (error) {
    const serverLog = log.join('').split(/(?<=\n)/).slice(-20).join('')
    throw new GenerateError(`${serverLog}cannot list the server's tools: ${causes(error).join('; ')}`)
  }
}

/** The subcommand a tool becomes: underscores read as dashes. */
export function commandName(toolName: string): string {
  return toolName.replaceAll('_', '-')
}

/** Refuse a tool list no CLI can be made from. */
export function checkNames(tools: Tool[]): void {
  if (tools.length === 0) throw new GenerateError('the server lists no tools')
  const seen = new Map<string, string>()
  for (const tool of tools) {
    const command = commandName(tool.name)
    if (command.startsWith('-')) {
      throw new GenerateError(`tool '${tool.name}' would become the option '${command}'`)
    }
    const other = seen.get(command)
    if (other !== undefined) {
      throw new GenerateError(`tools '${other}' and '${tool.name}' both become '${command}'`)
    }
    seen.set(command, tool.name)
  }
}

export interface GeneratorArgs {
  name: string
  out: string
  server: Server
}

/**
 * Read the arguments both generators take: --name, --out, and either --url or
 * the stdio server command after `--`. A stdio server starts in the caller's
 * directory unless --cwd names one, so a command such as `npx -y pkg` runs on
 * any machine.
 */
export function generatorArgs(argv: string[]): GeneratorArgs {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        name: { type: 'string' },
        out: { type: 'string' },
        url: { type: 'string' },
        cwd: { type: 'string' },
      },
      allowPositionals: true,
    })
  } catch (error) {
    throw new GenerateError(causes(error).join('; '))
  }
  const { name, out, url, cwd } = parsed.values
  const command = parsed.positionals
  if (name === undefined || out === undefined) throw new GenerateError('--name and --out are required')
  if (!NAME_PATTERN.test(name)) {
    throw new GenerateError(`--name '${name}' is not a lowercase word like grafana or my-tool`)
  }
  if ((url !== undefined) === command.length > 0) {
    throw new GenerateError('give either --url or a server command after --')
  }
  const server: Server =
    url !== undefined ? { url } : { command, cwd: cwd !== undefined ? resolve(cwd) : null }
  return { name, out, server }
}

/** Substitute the placeholders of a template in one pass. */
export function fill(template: string, name: string, server: Server, tools: Tool[]): string {
  const values: Record<string, string> = {
    NAME: name,
    NAME_LITERAL: JSON.stringify(name),
    ATTR: name.toUpperCase().replaceAll('-', '_'),
    SERVER: JSON.stringify(server, null, 2),
    TOOLS: JSON.stringify(tools, null, 2),
  }
  return template.replace(PLACEHOLDER, (_match, key: string) => values[key] ?? '')
}

/** Run a generator's main and turn a refusal into stderr plus exit 1. */
export async function runGenerator(write: (args: GeneratorArgs, tools: Tool[]) => void): Promise<void> {
  try {
    const args = generatorArgs(process.argv.slice(2))
    const tools = await fetchTools(args.server)
    checkNames(tools)
    write(args, tools)
    process.stderr.write(`wrote ${args.out} with ${tools.length} commands\n`)
  } catch (error) {
    if (!(error instanceof GenerateError)) throw error
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  await runGenerator(({ name, out, server }, tools) => {
    writeFileSync(out, fill(TEMPLATE, name, server, tools))
    chmodSync(out, 0o755)
  })
}
