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

import { Buffer } from 'node:buffer'
import { fromJsonSchema } from '@modelcontextprotocol/server'
import type { MirageToolOperations } from '@struktoai/mirage-core/workspace/tools/tool_operations'
import { failureText } from '@struktoai/mirage-core/errors/classify'
import type { JsonValue } from '@struktoai/mirage-core/types'
import { VERSION } from '@struktoai/mirage-core/version'
import { Session } from '@struktoai/mirage-core/workspace/workspace/handle'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { explanationToDict, failureToDict, ioResultToDict } from '../io_serde.ts'
import { TOOLS } from '../mcp/server.ts'
import {
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_NOT_FOUND,
  RPC_PARSE_ERROR,
} from './constants.ts'
import { VFS_CALLS, CallArgsError, answered, checked, type VfsCall } from '../vfs_calls.ts'

const PROTOCOL_VERSION = '1'
export const CANCEL_REQUEST = '$/cancelRequest'
export const RPC_REQUEST_CANCELLED = -32800

type Params = Readonly<Record<string, unknown>>
type Message = Readonly<Record<string, unknown>>
type Response = Record<string, JsonValue>

/** A JSON-RPC error answer. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data: Record<string, JsonValue> | null = null,
  ) {
    super(message)
  }
}

/** A JSON-RPC error response. */
export function errorResponse(
  requestId: JsonValue,
  code: number,
  message: string,
  data: JsonValue = null,
): Response {
  const error: Record<string, JsonValue> = { code, message }
  if (data !== null) error.data = data
  return { jsonrpc: '2.0', id: requestId, error }
}

function text(params: Params, name: string): string {
  const value = params[name]
  if (typeof value !== 'string') throw new RpcError(RPC_INVALID_PARAMS, `${name} must be a string`)
  return value
}

function bytes(params: Params, name: string): Uint8Array {
  const value = text(params, name)
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new RpcError(RPC_INVALID_PARAMS, `${name} must be base64`)
  }
  return new Uint8Array(Buffer.from(value, 'base64'))
}

function flag(params: Params, name: string): boolean {
  const value = params[name] ?? false
  if (typeof value !== 'boolean')
    throw new RpcError(RPC_INVALID_PARAMS, `${name} must be a boolean`)
  return value
}

export interface MirageRpcServerOptions {
  /** The session the methods act as; the workspace's default when absent. */
  sessionId?: string
  /** The tool table to serve, built for the session when absent. */
  operations?: MirageToolOperations
  name?: string
  version?: string
}

/**
 * Serves one session of a workspace over JSON-RPC 2.0. The methods are
 * the in-app Session API under the same names: `shell` is
 * `session.shell`, `glob` is `session.glob`, `vfs/<call>` is
 * `session.vfs.<call>`, and `tools/<tool>` runs one of the session's agent
 * tools, which `tools/list` and `tools/call` also serve with MCP's
 * schemas. `shell` and `vfs/<call>` take `explain: true` to answer what the
 * call would do instead of doing it (`session.explain`). Bytes travel as
 * base64. `$/cancelRequest` cancels a running request.
 */
export class MirageRpcServer {
  readonly sessionId: string
  protected readonly ws: Workspace
  private readonly session: Session
  private readonly operations: MirageToolOperations
  private readonly name: string
  private readonly version: string
  private readonly table: Record<
    string,
    (params: Params, signal?: AbortSignal) => Promise<JsonValue>
  >

  constructor(workspace: Workspace, options: MirageRpcServerOptions = {}) {
    this.ws = workspace
    this.sessionId = options.sessionId ?? workspace.defaultSessionId
    this.session = new Session(workspace, this.sessionId)
    this.operations = options.operations ?? this.session.tools
    this.name = options.name ?? 'mirage'
    this.version = options.version ?? VERSION
    this.table = {
      initialize: () =>
        Promise.resolve({
          server_info: { name: this.name, version: this.version },
          protocol_version: PROTOCOL_VERSION,
          workspace_id: this.ws.workspaceId,
          session_id: this.sessionId,
          methods: this.methods,
        }),
      shell: (params, signal) => this.shell(params, signal),
      glob: async (params) => ({ paths: await this.session.glob(text(params, 'pattern')) }),
      ...Object.fromEntries(
        VFS_CALLS.map((call) => [`vfs/${call.name}`, (params: Params) => this.vfs(call, params)]),
      ),
      'tools/list': async () => {
        const names = await this.operations.offered()
        return {
          tools: TOOLS.filter((tool) => names.includes(tool.name)).map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema as JsonValue,
            ...(tool.annotations === undefined
              ? {}
              : { annotations: tool.annotations as JsonValue }),
          })),
        }
      },
      'tools/call': (params, signal) => this.toolsCall(params, signal),
      ...Object.fromEntries(
        TOOLS.map((tool) => [
          `tools/${tool.name}`,
          (params: Params, signal?: AbortSignal) =>
            this.toolsCall({ name: tool.name, arguments: params }, signal),
        ]),
      ),
    }
  }

  /** Every method this server answers. */
  get methods(): string[] {
    return Object.keys(this.table)
  }

  /** Run one shell line in the session; `signal` aborts it. */
  async runLine(
    command: string,
    options: { cwd?: string; env?: Record<string, string>; stdin?: Uint8Array },
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    return ioResultToDict(
      await this.session.shell(command, {
        ...options,
        ...(signal === undefined ? {} : { signal }),
      }),
    )
  }

  /** Answer one JSON-RPC message; null for a notification. */
  async handle(message: Message, signal?: AbortSignal): Promise<Response | null> {
    const requestId = (message.id ?? null) as JsonValue
    const method = message.method
    if (message.jsonrpc !== '2.0') {
      if (!('id' in message)) return null
      return errorResponse(requestId, RPC_INVALID_REQUEST, 'jsonrpc must be "2.0"')
    }
    if (typeof method !== 'string') {
      if (!('id' in message)) return null
      return errorResponse(requestId, RPC_INVALID_REQUEST, 'method must be a string')
    }
    if (!('id' in message)) return null
    const handler = this.table[method]
    if (handler === undefined) {
      return errorResponse(requestId, RPC_METHOD_NOT_FOUND, `method not found: ${method}`)
    }
    const params = message.params ?? {}
    if (typeof params !== 'object' || Array.isArray(params)) {
      return errorResponse(requestId, RPC_INVALID_PARAMS, 'params must be an object')
    }
    try {
      signal?.throwIfAborted()
      const result = await handler(params as Params, signal)
      return { jsonrpc: '2.0', id: requestId, result }
    } catch (err) {
      if (err instanceof RpcError) return errorResponse(requestId, err.code, err.message, err.data)
      if (signal?.aborted === true) {
        return errorResponse(requestId, RPC_REQUEST_CANCELLED, 'request cancelled')
      }
      const data = failureToDict(err)
      const code = data.errno === 'ENOENT' ? RPC_NOT_FOUND : RPC_INTERNAL_ERROR
      return errorResponse(requestId, code, failureText(err), data)
    }
  }

  /**
   * Answer newline-delimited JSON-RPC until the input ends. Each request
   * runs on its own, so a long `shell` does not hold the stream, answers
   * go out as they finish, and `$/cancelRequest` reaches a running
   * request, which then answers -32800.
   */
  async serve(lines: AsyncIterable<string>, write: (text: string) => void): Promise<void> {
    const running = new Map<string, { stop: AbortController; done: Promise<void> }>()
    for await (const line of lines) {
      if (line.trim() === '') continue
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        write(JSON.stringify(errorResponse(null, RPC_PARSE_ERROR, 'parse error')) + '\n')
        continue
      }
      if (typeof message !== 'object' || message === null || Array.isArray(message)) {
        write(
          JSON.stringify(errorResponse(null, RPC_INVALID_REQUEST, 'a message is an object')) + '\n',
        )
        continue
      }
      const parsed = message as Message
      if (parsed.method === CANCEL_REQUEST) {
        const params = parsed.params as { id?: JsonValue } | undefined
        running.get(JSON.stringify(params?.id ?? null))?.stop.abort()
        continue
      }
      const key = JSON.stringify(parsed.id ?? null)
      const stop = new AbortController()
      const done = this.handle(parsed, stop.signal).then((response) => {
        running.delete(key)
        if (response !== null) write(JSON.stringify(response) + '\n')
      })
      running.set(key, { stop, done })
    }
    await Promise.all([...running.values()].map((call) => call.done))
  }

  private async shell(params: Params, signal?: AbortSignal): Promise<JsonValue> {
    if (flag(params, 'explain')) {
      if (Object.keys(params).some((key) => key !== 'command' && key !== 'explain')) {
        throw new RpcError(RPC_INVALID_PARAMS, 'explain takes the line alone: no cwd, env or stdin')
      }
      return explanationToDict(await this.session.explain.shell(text(params, 'command')))
    }
    const { cwd, env } = params
    if (cwd !== undefined && typeof cwd !== 'string') {
      throw new RpcError(RPC_INVALID_PARAMS, 'cwd must be a string')
    }
    if (
      env !== undefined &&
      (typeof env !== 'object' ||
        env === null ||
        Object.values(env).some((value) => typeof value !== 'string'))
    ) {
      throw new RpcError(RPC_INVALID_PARAMS, 'env must map names to strings')
    }
    return this.runLine(
      text(params, 'command'),
      {
        ...(cwd === undefined ? {} : { cwd }),
        ...(env === undefined ? {} : { env: env as Record<string, string> }),
        ...('stdin_base64' in params ? { stdin: bytes(params, 'stdin_base64') } : {}),
      },
      signal,
    )
  }

  /** One VFS call, or its explanation with `explain: true`. Mirrors Python's `_vfs`. */
  private async vfs(call: VfsCall, params: Params): Promise<JsonValue> {
    const explain = flag(params, 'explain')
    const rest = Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'explain'))
    let args: Record<string, unknown>
    try {
      args = await checked(call, rest)
    } catch (err) {
      if (err instanceof CallArgsError) throw new RpcError(RPC_INVALID_PARAMS, err.message)
      throw err
    }
    return answered(this.session, call, args, explain)
  }

  private async toolsCall(params: Params, signal?: AbortSignal): Promise<JsonValue> {
    const name = text(params, 'name')
    const tool = TOOLS.find((candidate) => candidate.name === name)
    if (tool === undefined || !(await this.operations.offered()).includes(name)) {
      throw new RpcError(RPC_INVALID_PARAMS, `Tool ${name} not found`)
    }
    const args = params.arguments ?? {}
    if (typeof args !== 'object' || Array.isArray(args)) {
      throw new RpcError(RPC_INVALID_PARAMS, 'arguments must be an object')
    }
    const checked = await fromJsonSchema(tool.inputSchema)['~standard'].validate(args)
    if (checked.issues !== undefined) {
      const why = checked.issues.map((issue) => issue.message).join('; ')
      throw new RpcError(RPC_INVALID_PARAMS, `Invalid arguments for tool ${name}: ${why}`)
    }
    const result = await this.operations.call(name, args as Record<string, unknown>, signal)
    return { text: result.content[0]?.text ?? '', is_error: result.isError === true }
  }
}
