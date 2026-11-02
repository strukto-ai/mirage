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
  StreamableHTTPClientTransport,
  Tool,
} from '@modelcontextprotocol/client'
import type { MCPConfig } from '../core/mcp/config.ts'
import type { JsonValue } from '../types.ts'
import { abortable } from '../utils/abort.ts'
import { VERSION } from '../version.ts'
import { Accessor } from './base.ts'

/** How long one request may take, in milliseconds. */
export const TIMEOUT = 300_000
export const MAX_PAGES = 64

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

  /** An initialized client, which the caller closes. */
  async connect(signal?: AbortSignal): Promise<Client> {
    const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client')
    const transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
      requestInit: { headers: this.headers() },
    })
    const client = new Client({ name: 'mirage', version: VERSION }, { listMaxPages: MAX_PAGES })
    try {
      await client.connect(transport, { timeout: TIMEOUT, ...(signal ? { signal } : {}) })
    } catch (error) {
      await client.close()
      throw error
    }
    return client
  }

  /** End the server's MCP session, then close the client, as Python's SDK does on close. */
  private async shut(client: Client): Promise<void> {
    try {
      await (client.transport as StreamableHTTPClientTransport | undefined)?.terminateSession()
    } catch (error) {
      logger.debug?.(`MCP session end failed: ${String(error)}`)
    }
    await client.close()
  }

  /** Run `use` on an initialized client, closed when it settles. */
  async session<T>(use: (client: Client) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const client = await this.connect(signal)
    try {
      return await use(client)
    } finally {
      await this.shut(client)
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
    if (!this.dropped.delete(opening)) return
    void opening
      .then((client) => this.shut(client))
      .catch((error: unknown) => {
        logger.debug?.(`MCP client close failed: ${String(error)}`)
      })
  }

  /** The server's title and every tool it lists; the SDK reads every page. */
  async listTools(): Promise<[string, Tool[]]> {
    return this.session(async (client) => {
      const { tools } = await client.listTools({}, { timeout: TIMEOUT })
      const info = client.getServerVersion()
      if (info === undefined) return ['', tools]
      return [info.title === undefined || info.title === '' ? info.name : info.title, tools]
    })
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
        { timeout: TIMEOUT, ...(signal ? { signal } : {}) },
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
    for (const opening of openings) {
      try {
        await this.shut(await opening)
      } catch (error) {
        logger.debug?.(`MCP client close failed: ${String(error)}`)
      }
    }
  }
}
