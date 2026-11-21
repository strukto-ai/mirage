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

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { constants } from 'node:os'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { debuglog } from 'node:util'
import type { JsonValue } from '@struktoai/mirage-core/types'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import { traceHeaders } from '../env.ts'
import {
  ACP_INTERNAL_ERROR,
  ACP_INVALID_PARAMS,
  ACP_RESOURCE_NOT_FOUND,
  FILE_METHODS,
  FORK_SESSION,
  INITIALIZE,
  LINE_BREAK,
  LINE_LIMIT,
  NEW_SESSION,
  READ_TEXT_FILE,
  RPC_NOT_FOUND,
  RPC_TIMEOUT,
  SESSION_METHODS,
} from './constants.ts'
import { WorkspaceCallError } from './errors.ts'
import type { HostWrite, WorkspaceCall } from './types.ts'

const logger = { debug: debuglog('mirage') }

type JsonRecord = Record<string, JsonValue>
type Agent = ChildProcessByStdio<Writable, Readable, null>

function isRecord(value: JsonValue | undefined): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `initialize` params that offer the agent the client's file methods, which
 * the relay answers from the workspace.
 */
export function withFiles(params: JsonRecord): JsonRecord {
  const held = params.clientCapabilities
  const capabilities: JsonRecord = isRecord(held) ? { ...held } : {}
  const files = capabilities.fs
  capabilities.fs = { ...(isRecord(files) ? files : {}), readTextFile: true, writeTextFile: true }
  return { ...params, clientCapabilities: capabilities }
}

/**
 * Session params that hand the agent the workspace's MCP server. A server
 * of the same name the client sent is replaced. Claude's ACP adapter also
 * reads `_meta.claudeCode.options`: an empty `tools` there turns its
 * built-in tools off, so it works through the workspace's tools, unless the
 * client set its own.
 */
export function withMirage(params: JsonRecord, server: JsonRecord): JsonRecord {
  const sent = params.mcpServers
  const kept = (Array.isArray(sent) ? sent : []).filter(
    (one) => !(isRecord(one) && one.name === server.name),
  )
  const held = params._meta
  const meta: JsonRecord = isRecord(held) ? { ...held } : {}
  const claude = meta.claudeCode
  const adapter: JsonRecord = isRecord(claude) ? { ...claude } : {}
  const given = adapter.options
  const options: JsonRecord = isRecord(given) ? { ...given } : {}
  if (!('tools' in options)) options.tools = []
  adapter.options = options
  meta.claudeCode = adapter
  return { ...params, mcpServers: [...kept, server], _meta: meta }
}

/**
 * Where an agent's absolute path lands in the workspace: under `root` for a
 * path in the session's folder (`cwd`, null when unknown), as given
 * otherwise.
 */
export function workspacePath(path: string, cwd: string | null, root: string): string {
  if (cwd !== null) {
    const base = rstripSlash(cwd)
    if (path === (base === '' ? '/' : base)) return root
    if (path.startsWith(`${base}/`)) return rstripSlash(root) + path.slice(base.length)
  }
  return path
}

/**
 * The lines ACP's `line` (1-based, null from the top) and `limit` (null to
 * the end) pick from a file, each ending at CRLF, CR or LF.
 */
export function textSlice(text: string, line: number | null, limit: number | null): string {
  if (line === null && limit === null) return text
  const parts = text.split(LINE_BREAK)
  const lines: string[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) lines.push(`${parts[i] ?? ''}${parts[i + 1] ?? ''}`)
  const last = parts[parts.length - 1] ?? ''
  if (last !== '') lines.push(last)
  const start = line !== null ? Math.max(line - 1, 0) : 0
  const end = limit !== null ? start + limit : undefined
  return lines.slice(start, end).join('')
}

function parse(line: string): JsonValue {
  try {
    return JSON.parse(line) as JsonValue
  } catch (err) {
    logger.debug('acp line is not JSON: %s', err)
    return null
  }
}

/**
 * One ACP agent between its client and a workspace. Every message passes
 * through unchanged but three: `initialize` offers the agent the client's
 * file methods, a session request hands it the workspace's MCP server, and
 * the agent's file requests are answered from the workspace, never reaching
 * the client.
 */
export class AgentRelay {
  private readonly agent: Agent
  private readonly call: WorkspaceCall
  private readonly server: JsonRecord
  private readonly root: string
  private readonly hostWrite: HostWrite
  private readonly folders = new Map<string, string>()
  private readonly opening = new Map<string, string>()
  private readonly answers = new Set<Promise<void>>()
  private writing: Promise<void> = Promise.resolve()

  constructor(
    agent: Agent,
    call: WorkspaceCall,
    server: JsonRecord,
    root: string,
    hostWrite: HostWrite,
  ) {
    this.agent = agent
    this.call = call
    this.server = server
    this.root = root
    this.hostWrite = hostWrite
  }

  /** Pass one client line to the agent, rewriting `initialize` and the session requests. */
  async fromHost(line: string): Promise<void> {
    const message = parse(line)
    let text = line
    if (isRecord(message) && 'id' in message) {
      const method = message.method
      const params = message.params
      if (method === INITIALIZE && isRecord(params)) {
        text = JSON.stringify({ ...message, params: withFiles(params) })
      } else if (typeof method === 'string' && SESSION_METHODS.has(method) && isRecord(params)) {
        const folder = params.cwd
        const session = params.sessionId
        if (typeof folder === 'string') {
          if (method === NEW_SESSION || method === FORK_SESSION) {
            this.opening.set(JSON.stringify(message.id), folder)
          } else if (typeof session === 'string') {
            this.folders.set(session, folder)
          }
        }
        text = JSON.stringify({ ...message, params: withMirage(params, this.server) })
      }
    }
    await this.toAgent(text)
  }

  /** Answer one agent line's file request from the workspace, or pass the line to the client. */
  async fromAgent(line: string): Promise<void> {
    const message = parse(line)
    if (isRecord(message)) {
      const method = message.method
      if (typeof method === 'string' && FILE_METHODS.has(method) && 'id' in message) {
        const answer = this.answer(message).finally(() => this.answers.delete(answer))
        this.answers.add(answer)
        return
      }
      if (!('method' in message) && 'id' in message) {
        const key = JSON.stringify(message.id)
        const folder = this.opening.get(key)
        this.opening.delete(key)
        const result = message.result
        if (folder !== undefined && isRecord(result) && typeof result.sessionId === 'string') {
          this.folders.set(result.sessionId, folder)
        }
      }
    }
    await this.hostWrite(line)
  }

  /** Wait for the file answers still running. */
  async close(): Promise<void> {
    await Promise.allSettled([...this.answers])
  }

  private async answer(message: JsonRecord): Promise<void> {
    const held = message.params
    const params = isRecord(held) ? held : {}
    const id = message.id ?? null
    let reply: JsonRecord
    try {
      const result =
        message.method === READ_TEXT_FILE ? await this.read(params) : await this.write(params)
      reply = { jsonrpc: '2.0', id, result }
    } catch (error) {
      if (error instanceof WorkspaceCallError) {
        const code =
          error.code === RPC_NOT_FOUND
            ? ACP_RESOURCE_NOT_FOUND
            : error.code === ACP_INVALID_PARAMS
              ? ACP_INVALID_PARAMS
              : ACP_INTERNAL_ERROR
        reply = { jsonrpc: '2.0', id, error: { code, message: error.message } }
      } else {
        logger.debug('acp file request failed: %s', error)
        const message = error instanceof Error ? error.message : String(error)
        reply = { jsonrpc: '2.0', id, error: { code: ACP_INTERNAL_ERROR, message } }
      }
    }
    await this.toAgent(JSON.stringify(reply))
  }

  private path(params: JsonRecord): string {
    const path = params.path
    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw new WorkspaceCallError(ACP_INVALID_PARAMS, 'path must be an absolute path')
    }
    const session = params.sessionId
    const folder = typeof session === 'string' ? (this.folders.get(session) ?? null) : null
    return workspacePath(path, folder, this.root)
  }

  private async read(params: JsonRecord): Promise<JsonRecord> {
    const found = await this.call('vfs/read', { path: this.path(params) })
    const data = isRecord(found) ? found.data : undefined
    if (typeof data !== 'string') {
      throw new WorkspaceCallError(ACP_INTERNAL_ERROR, 'the workspace answered no data')
    }
    const text = Buffer.from(data, 'base64').toString('utf8')
    const line = params.line
    const limit = params.limit
    return {
      content: textSlice(
        text,
        typeof line === 'number' ? line : null,
        typeof limit === 'number' ? limit : null,
      ),
    }
  }

  private async write(params: JsonRecord): Promise<JsonRecord> {
    const content = params.content
    if (typeof content !== 'string') {
      throw new WorkspaceCallError(ACP_INVALID_PARAMS, 'content is required')
    }
    const data = Buffer.from(content, 'utf8').toString('base64')
    await this.call('vfs/write', { path: this.path(params), data })
    return {}
  }

  private toAgent(line: string): Promise<void> {
    const stdin = this.agent.stdin
    this.writing = this.writing.then(
      () =>
        new Promise<void>((resolve) => {
          if (stdin.destroyed || !stdin.writable) {
            resolve()
            return
          }
          stdin.write(`${line}\n`, (err) => {
            if (err) logger.debug('acp agent stopped reading: %s', err)
            resolve()
          })
        }),
    )
    return this.writing
  }
}

/**
 * Run an ACP agent (`argv`) and relay its client's lines (`hostLines`)
 * through it, writing the client's side with `hostWrite`. `call` reaches the
 * workspace's RPC, `server` is the workspace's MCP server for each session
 * and `root` the workspace path a session's folder stands for. Resolves to
 * the agent's exit status, 128 plus the signal for one a signal ended;
 * rejects with an ENOENT error when there is no program `argv[0]`, and with
 * what ended the client's lines early, after stopping the agent.
 */
export async function relayAgent(
  argv: string[],
  call: WorkspaceCall,
  server: JsonRecord,
  root: string,
  hostLines: AsyncIterable<string>,
  hostWrite: HostWrite,
): Promise<number> {
  // Taken before the first await: readline drops the lines it reads while
  // no iterator listens, and a client sends initialize at once.
  const incoming = hostLines[Symbol.asyncIterator]()
  const [program, ...args] = argv
  if (program === undefined) throw new Error('acp: no agent command')
  const agent: Agent = spawn(program, args, { stdio: ['pipe', 'pipe', 'inherit'] })
  await new Promise<void>((resolve, reject) => {
    agent.once('spawn', () => {
      resolve()
    })
    agent.once('error', reject)
  })
  const exited = new Promise<number>((resolve) => {
    agent.once('close', (code, signal) => {
      resolve(code ?? 128 + (signal !== null ? constants.signals[signal] : 0))
    })
  })
  agent.stdin.on('error', (err) => {
    logger.debug('acp agent stdin closed: %s', err)
  })
  const relay = new AgentRelay(agent, call, server, root, hostWrite)
  const client: { failed: Error | null } = { failed: null }
  void (async () => {
    for (let next = await incoming.next(); next.done !== true; next = await incoming.next()) {
      const text = next.value.replace(/\r?\n$/, '')
      if (text.trim() !== '') await relay.fromHost(text)
    }
    agent.stdin.end()
  })().catch((err: unknown) => {
    logger.debug('acp client stream failed: %s', err)
    client.failed = err instanceof Error ? err : new Error(String(err))
    agent.kill('SIGKILL')
  })
  try {
    for await (const line of createInterface({ input: agent.stdout, crlfDelay: Infinity })) {
      if (line.length > LINE_LIMIT) throw new Error('acp: an agent line is over the limit')
      if (line.trim() !== '') await relay.fromAgent(line)
    }
    const status = await exited
    if (client.failed !== null) throw client.failed
    return status
  } finally {
    if (agent.exitCode === null && agent.signalCode === null) {
      agent.kill('SIGKILL')
      await exited
    }
    await relay.close()
  }
}

/**
 * Relay this process's ACP client to an agent (`argv`), its files the
 * workspace's: `url` is the workspace's `/v1/workspaces/:id/rpc`, and the
 * bearer token is asked for on every request, so a login refreshed while
 * the relay runs is sent; an empty one sends none. Resolves to the agent's
 * exit status.
 */
export async function relayStdio(
  argv: string[],
  url: string,
  token: () => Promise<string>,
  server: JsonRecord,
  root: string,
): Promise<number> {
  let ids = 0
  const call: WorkspaceCall = async (method, params) => {
    ids += 1
    const bearer = await token()
    const signal = AbortSignal.timeout(RPC_TIMEOUT * 1000)
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          ...traceHeaders(process.env),
          ...(bearer !== '' ? { Authorization: `Bearer ${bearer}` } : {}),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ids, method, params }),
        signal,
      })
    } catch (err) {
      logger.debug('acp workspace call failed: %s', err)
      throw new WorkspaceCallError(
        ACP_INTERNAL_ERROR,
        signal.aborted
          ? 'the workspace did not answer in time'
          : `the workspace is unreachable: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    let body: JsonValue
    try {
      body = (await response.json()) as JsonValue
    } catch (err) {
      logger.debug('acp rpc answer is not JSON: %s', err)
      throw new WorkspaceCallError(
        ACP_INTERNAL_ERROR,
        signal.aborted
          ? 'the workspace did not answer in time'
          : `error ${String(response.status)}`,
      )
    }
    const error = isRecord(body) ? body.error : undefined
    if (isRecord(error)) {
      const code = error.code
      throw new WorkspaceCallError(
        typeof code === 'number' ? code : ACP_INTERNAL_ERROR,
        typeof error.message === 'string' ? error.message : '',
      )
    }
    if (response.status >= 400 || !isRecord(body)) {
      throw new WorkspaceCallError(ACP_INTERNAL_ERROR, `error ${String(response.status)}`)
    }
    return body.result ?? null
  }
  const write: HostWrite = (line) =>
    new Promise<void>((resolve) => {
      process.stdout.write(`${line}\n`, () => {
        resolve()
      })
    })
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  try {
    return await relayAgent(argv, call, server, root, lines, write)
  } finally {
    lines.close()
  }
}
