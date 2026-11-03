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

import type {
  CallToolResult,
  Client,
  FetchLike,
  StreamableHTTPClientTransport,
  Tool,
} from '@modelcontextprotocol/client'
import type { MCPConfig } from '../core/mcp/config.ts'
import {
  MAX_PAGES,
  MAX_REPLY,
  REPLY_ENCODING,
  REPLY_TOO_LARGE,
  TIMEOUT,
} from '../core/mcp/constants.ts'
import type { JsonValue } from '../types.ts'
import { abortable } from '../utils/abort.ts'
import { VERSION } from '../version.ts'
import { Accessor } from './base.ts'

/** Where a failed MCP session end or client close is reported; silent until a host sets `debug`. */
export const logger: { debug?: (message: string) => void } = {}

/**
 * Whether the server read the request and refused it, which says nothing
 * against the connection: a JSON-RPC error outside the codes the SDK spends
 * on transport, timeout and session faults. Mirrors Python's `answered`.
 */
export async function answered(error: unknown): Promise<boolean> {
  const { INVALID_PARAMS, METHOD_NOT_FOUND, ProtocolError } =
    await import('@modelcontextprotocol/client')
  if (!(error instanceof ProtocolError)) return false
  const code = error.code
  return code === INVALID_PARAMS || code === METHOD_NOT_FOUND || code < -32768 || code > -32000
}

/**
 * Whether the SDK gave up waiting for the server's answer, or a deadline ran
 * out. Mirrors Python's `timed_out`.
 */
export async function timedOut(error: unknown): Promise<boolean> {
  if (error instanceof Error && error.name === 'TimeoutError') return true
  const { SdkError, SdkErrorCode } = await import('@modelcontextprotocol/client')
  return error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout
}

/**
 * Which reply refusal a call failed with, `REPLY_TOO_LARGE` or
 * `REPLY_ENCODING`, found through any aggregate error; undefined for any
 * other failure. Mirrors Python's `refusal`.
 */
export function refusal(error: unknown): string | undefined {
  if (error instanceof AggregateError) {
    return error.errors.map(refusal).find((reason) => reason !== undefined)
  }
  if (!(error instanceof Error)) return undefined
  return [REPLY_TOO_LARGE, REPLY_ENCODING].find((reason) => error.message.includes(reason))
}

/**
 * A fetch that cuts each response body at `MAX_REPLY` bytes, or every body
 * together when `shared`, as a listing's pages share one cap. Past the cap
 * an SSE answer to a request ends with that request's JSON-RPC error, since
 * the SDK leaves a request whose stream broke unanswered until the timeout;
 * any other body fails. fetch inflates a body before it is counted. Mirrors
 * Python's `reply_cap`, whose SDK answers a broken stream itself.
 */
export function replyCap(shared: boolean): FetchLike {
  const listing = { left: MAX_REPLY }
  return async (url, init) => {
    const response = await fetch(url, init)
    if (response.body === null) return response
    const left = shared ? listing : { left: MAX_REPLY }
    const sse = (response.headers.get('content-type') ?? '')
      .toLowerCase()
      .startsWith('text/event-stream')
    const request =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as { id?: unknown }) : {}
    const { INTERNAL_ERROR } = await import('@modelcontextprotocol/client')
    const refusal =
      sse && request.id !== undefined
        ? new TextEncoder().encode(
            `\n\nevent: message\ndata: ${JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              error: { code: INTERNAL_ERROR, message: REPLY_TOO_LARGE },
            })}\n\n`,
          )
        : null
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          left.left -= chunk.byteLength
          if (left.left >= 0) {
            controller.enqueue(chunk)
          } else if (refusal === null) {
            controller.error(new Error(REPLY_TOO_LARGE))
          } else {
            controller.enqueue(refusal)
            controller.terminate()
          }
        },
      }),
    )
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}

/**
 * A streamable-HTTP MCP server, one client kept per install.
 *
 * The client opens on first use and stays open until the CLI is removed. A
 * call that fails drops it, unless the server answered it with an error: the
 * next call reopens one, and the dropped one closes once the calls running on
 * it end. A cancelled call leaves it open. Unlike Python, every caller shares it: each request's
 * fetch goes through its caller's pool, so its rule and policies judge it.
 * The SDK loads on the first request, so building or restoring an MCP CLI
 * never imports it.
 */
export class MCPAccessor extends Accessor {
  private opening: Promise<Client> | null = null
  private readonly calls = new Map<Promise<Client>, number>()
  private readonly dropped = new Set<Promise<Client>>()
  private readonly closing = new Set<Promise<void>>()

  constructor(readonly config: MCPConfig) {
    super()
  }

  /** The one header `auth` asks for; none without auth. */
  headers(): Record<string, string> {
    const auth = this.config.auth
    if (auth === undefined || auth === null) return {}
    if (auth.type === 'bearer') return { Authorization: `Bearer ${auth.token}` }
    return { [auth.name ?? '']: auth.token }
  }

  /** An initialized client, which the caller closes; `shared` holds every reply to one cap. */
  async connect(signal?: AbortSignal, shared = false): Promise<Client> {
    const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client')
    const transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
      requestInit: { headers: this.headers() },
      fetch: replyCap(shared),
    })
    const client = new Client({ name: 'mirage', version: VERSION }, { listMaxPages: MAX_PAGES })
    try {
      await client.connect(transport, { timeout: TIMEOUT * 1000, ...(signal ? { signal } : {}) })
    } catch (error) {
      await client.close()
      throw error
    }
    return client
  }

  /**
   * End the server's MCP session, waiting at most the call timeout and never
   * past `signal`, then close the client, which aborts a session end still in
   * flight.
   */
  private async shut(client: Client, signal?: AbortSignal): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await abortable(
        Promise.race([
          (client.transport as StreamableHTTPClientTransport | undefined)?.terminateSession(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error('the server did not end the session in time'))
            }, TIMEOUT * 1000)
          }),
        ]),
        signal,
      )
    } catch (error) {
      logger.debug?.(`MCP session end failed: ${String(error)}`)
    } finally {
      clearTimeout(timer)
    }
    await client.close()
  }

  /** Shut `opening` in the background, kept in `closing` so `close` joins it. */
  private shutting(opening: Promise<Client>): Promise<void> {
    const done: Promise<void> = opening
      .then((client) => this.shut(client))
      .catch((error: unknown) => {
        logger.debug?.(`MCP client close failed: ${String(error)}`)
      })
      .finally(() => {
        this.closing.delete(done)
      })
    this.closing.add(done)
    return done
  }

  /**
   * Run `use` on an initialized client, closed when it settles; `signal` also
   * bounds ending the session, and `shared` holds every reply to one cap.
   */
  async session<T>(
    use: (client: Client) => Promise<T>,
    signal?: AbortSignal,
    shared = false,
  ): Promise<T> {
    const client = await this.connect(signal, shared)
    try {
      return await use(client)
    } finally {
      await this.shut(client, signal)
    }
  }

  /** The kept client's opening, started when there is none. */
  private kept(): Promise<Client> {
    if (this.opening === null) {
      const opening = this.connect()
      this.opening = opening
      opening.catch(() => {
        if (this.opening === opening) this.opening = null
      })
    }
    return this.opening
  }

  /** Stop handing out `opening`; it closes once the calls running on it end. */
  private drop(opening: Promise<Client>): void {
    if (this.opening === opening) this.opening = null
    this.dropped.add(opening)
  }

  /**
   * Count a call off `opening`, and start closing it if dropped and that was
   * its last; the call does not wait for the close, which may hang.
   */
  private release(opening: Promise<Client>): void {
    const left = (this.calls.get(opening) ?? 1) - 1
    if (left > 0) {
      this.calls.set(opening, left)
      return
    }
    this.calls.delete(opening)
    if (this.dropped.delete(opening)) void this.shutting(opening)
  }

  /** The server's title and every tool it lists; the SDK reads every page, all held to one reply cap and one `TIMEOUT`. */
  async listTools(): Promise<[string, Tool[]]> {
    const deadline = AbortSignal.timeout(TIMEOUT * 1000)
    return this.session(
      async (client) => {
        const { tools } = await client.listTools({}, { timeout: TIMEOUT * 1000, signal: deadline })
        const info = client.getServerVersion()
        if (info === undefined) return ['', tools]
        return [info.title === undefined || info.title === '' ? info.name : info.title, tools]
      },
      deadline,
      true,
    )
  }

  /** Call one tool on the kept client, abandoned when `signal` aborts. */
  async callTool(
    name: string,
    args: Record<string, JsonValue>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const opening = this.kept()
    this.calls.set(opening, (this.calls.get(opening) ?? 0) + 1)
    try {
      const client = await abortable(opening, signal)
      return await client.callTool(
        { name, arguments: args },
        { timeout: TIMEOUT * 1000, ...(signal ? { signal } : {}) },
      )
    } catch (error) {
      if (signal?.aborted !== true && !(await answered(error))) this.drop(opening)
      throw error
    } finally {
      this.release(opening)
    }
  }

  /** Close the kept client and any dropped one. */
  override async close(): Promise<void> {
    const openings = [...(this.opening === null ? [] : [this.opening]), ...this.dropped]
    this.opening = null
    this.dropped.clear()
    for (const opening of openings) void this.shutting(opening)
    while (this.closing.size > 0) await Promise.allSettled([...this.closing])
  }
}
