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

import type { CallToolResult } from '@modelcontextprotocol/client'
import type { MCPAccessor } from '../../../accessor/mcp.ts'
import { compactJsonText } from '../../../core/render/json.ts'
import { IOResult, type CommandOutput } from '../../../io/types.ts'
import type { JsonValue, PathSpec } from '../../../types.ts'
import type { Context } from '../../config.ts'

const ENCODER = new TextEncoder()

/** The leaf errors inside an aggregate error, one each, as `<name>: <message>`. */
export function causes(error: unknown): string[] {
  if (error instanceof AggregateError) return error.errors.flatMap(causes)
  if (error instanceof Error) return [`${error.name}: ${error.message}`]
  return [String(error)]
}

/** The subcommand a tool becomes: underscores read as dashes. */
export function commandName(toolName: string): string {
  return toolName.replaceAll('_', '-')
}

/** A tool's answer as text: text blocks as they are, others as compact JSON. */
export function render(result: Pick<CallToolResult, 'content' | 'structuredContent'>): string {
  const parts = result.content.map((block) =>
    block.type === 'text' ? block.text : compactJsonText(block),
  )
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(compactJsonText(result.structuredContent))
  }
  const text = parts.join('\n')
  return text === '' || text.endsWith('\n') ? text : `${text}\n`
}

/** Refuse a number too large for a double, which JSON.parse reads as Infinity. */
function finite(_key: string, value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new RangeError('not finite')
  return value
}

function refuse(message: string, code: number): CommandOutput {
  return [null, new IOResult({ exitCode: code, stderr: ENCODER.encode(`${message}\n`) })]
}

/**
 * Run one MCP tool with the JSON object given as its operand.
 *
 * @param tool the tool's MCP name.
 * @param accessor the install's server.
 * @param _paths unused; a tool takes no path.
 * @param texts at most one JSON object.
 * @param ctx the command context; its signal abandons the call.
 */
export async function callTool(
  tool: string,
  accessor: MCPAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandOutput> {
  const command = commandName(tool)
  if (texts.length > 1) return refuse(`${command}: takes one JSON object`, 2)
  let args: unknown
  try {
    args = texts.length > 0 ? JSON.parse(texts[0] ?? '', finite) : {}
  } catch {
    // The parser's own wording differs by host, so neither host prints it.
    return refuse(`${command}: invalid JSON`, 2)
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return refuse(`${command}: JSON must be an object`, 2)
  }
  let result: CallToolResult
  try {
    result = await accessor.callTool(tool, args as Record<string, JsonValue>, ctx.signal)
  } catch (error) {
    if (ctx.signal?.aborted === true) throw error
    return refuse(`${command}: MCP server failed: ${causes(error).join('; ')}`, 1)
  }
  const out = ENCODER.encode(render(result))
  if (result.isError === true) {
    const stderr = out.length > 0 ? out : ENCODER.encode(`${command}: the tool reported an error\n`)
    return [null, new IOResult({ exitCode: 1, stderr })]
  }
  return [out, new IOResult()]
}
