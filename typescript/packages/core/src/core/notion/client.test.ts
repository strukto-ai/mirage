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

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { auth } from '@modelcontextprotocol/client'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  HttpNotionTransport,
  MCPNotionTransport,
  MemoryOAuthClientProvider,
  NotionAPIError,
  NotionMCPError,
} from './client.ts'

interface CallToolParams {
  name: string
  arguments?: Record<string, unknown>
}

class FakeClient {
  connectCalls = 0
  invocations: { name: string; args: Record<string, unknown> }[] = []
  responses: unknown[] = []
  connect(): Promise<void> {
    this.connectCalls++
    return Promise.resolve()
  }
  callTool(params: CallToolParams): Promise<unknown> {
    this.invocations.push({ name: params.name, args: params.arguments ?? {} })
    if (this.responses.length === 0) return Promise.reject(new Error('no canned response'))
    return Promise.resolve(this.responses.shift())
  }
}

class TestTransport extends MCPNotionTransport {
  inject(c: unknown): void {
    ;(this as unknown as { client: unknown }).client = c
  }
}

const fakeAuthProvider = new MemoryOAuthClientProvider({
  clientMetadata: { redirect_uris: ['http://localhost/cb'] },
  redirect: () => undefined,
  redirectUrl: 'http://localhost/cb',
})

function makeTransport(): { transport: TestTransport; fake: FakeClient } {
  const transport = new TestTransport({ authProvider: fakeAuthProvider })
  const fake = new FakeClient()
  transport.inject(fake)
  return { transport, fake }
}

describe('MCPNotionTransport', () => {
  it('callTool invokes the underlying client and parses JSON text content', async () => {
    const { transport, fake } = makeTransport()
    fake.responses.push({ content: [{ type: 'text', text: '{"a":1}' }] })
    const result = await transport.callTool('API-post-search', { query: '' })
    expect(fake.invocations).toEqual([{ name: 'API-post-search', args: { query: '' } }])
    expect(result).toEqual({ a: 1 })
  })

  it('prefers structuredContent when both structuredContent and content are present', async () => {
    const { transport, fake } = makeTransport()
    fake.responses.push({
      structuredContent: { hello: 'world' },
      content: [{ type: 'text', text: '{"ignored":true}' }],
    })
    const result = await transport.callTool('API-get-self', {})
    expect(result).toEqual({ hello: 'world' })
  })

  it('throws NotionMCPError when isError=true, message includes the error text', async () => {
    const { transport, fake } = makeTransport()
    fake.responses.push({
      isError: true,
      content: [{ type: 'text', text: 'oops' }],
    })
    fake.responses.push({
      isError: true,
      content: [{ type: 'text', text: 'oops' }],
    })
    await expect(transport.callTool('API-post-search', {})).rejects.toBeInstanceOf(NotionMCPError)
    await expect(transport.callTool('API-post-search', {})).rejects.toThrow(/oops/)
  })

  it('throws NotionMCPError when text content is not valid JSON', async () => {
    const { transport, fake } = makeTransport()
    fake.responses.push({ content: [{ type: 'text', text: 'not json' }] })
    fake.responses.push({ content: [{ type: 'text', text: 'not json' }] })
    await expect(transport.callTool('API-post-search', {})).rejects.toBeInstanceOf(NotionMCPError)
    await expect(transport.callTool('API-post-search', {})).rejects.toThrow(
      /failed to parse tool result/,
    )
  })

  it('throws NotionMCPError("empty tool result") when content is empty and no structuredContent', async () => {
    const { transport, fake } = makeTransport()
    fake.responses.push({ content: [] })
    await expect(transport.callTool('API-post-search', {})).rejects.toThrow(/empty tool result/)
  })

  it('reuses a single connect() across two consecutive callTool calls', async () => {
    const { transport, fake } = makeTransport()
    fake.responses.push({ content: [{ type: 'text', text: '{"n":1}' }] })
    fake.responses.push({ content: [{ type: 'text', text: '{"n":2}' }] })
    await transport.callTool('A', {})
    await transport.callTool('B', {})
    expect(fake.connectCalls).toBe(1)
  })

  it('shares a single connect() across concurrent first callTool calls', async () => {
    const { transport, fake } = makeTransport()
    fake.responses.push({ content: [{ type: 'text', text: '{"n":1}' }] })
    fake.responses.push({ content: [{ type: 'text', text: '{"n":2}' }] })
    await Promise.all([transport.callTool('A', {}), transport.callTool('B', {})])
    expect(fake.connectCalls).toBe(1)
  })
})

interface RecordedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string | null
}

function makeHttpTransport(
  responses: { status: number; payload: unknown; headers?: Record<string, string> }[],
): {
  transport: HttpNotionTransport
  requests: RecordedRequest[]
} {
  const requests: RecordedRequest[] = []
  const fakeFetch = (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    requests.push({
      url: input instanceof URL ? input.toString() : typeof input === 'string' ? input : input.url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : null,
    })
    const next = responses.shift() ?? { status: 200, payload: {} }
    return Promise.resolve(
      new Response(JSON.stringify(next.payload), {
        status: next.status,
        headers: { 'Content-Type': 'application/json', ...next.headers },
      }),
    )
  }
  const transport = new HttpNotionTransport({ apiKey: 'k-123', baseUrl: 'http://mock/v1' })
  ;(transport as unknown as { fetch: typeof fetch }).fetch = fakeFetch
  return { transport, requests }
}

describe('HttpNotionTransport', () => {
  it('maps API-retrieve-a-page to GET /pages/{id} with auth headers', async () => {
    const { transport, requests } = makeHttpTransport([{ status: 200, payload: { id: 'p1' } }])
    const out = await transport.callTool('API-retrieve-a-page', { page_id: 'p1' })
    expect(out).toEqual({ id: 'p1' })
    expect(requests[0]?.url).toBe('http://mock/v1/pages/p1')
    expect(requests[0]?.method).toBe('GET')
    expect(requests[0]?.headers.Authorization).toBe('Bearer k-123')
    expect(requests[0]?.headers['Notion-Version']).toBe('2025-09-03')
  })

  it('maps API-post-search to POST /search with the args as JSON body', async () => {
    const { transport, requests } = makeHttpTransport([{ status: 200, payload: { results: [] } }])
    await transport.callTool('API-post-search', { page_size: 100 })
    expect(requests[0]?.url).toBe('http://mock/v1/search')
    expect(requests[0]?.method).toBe('POST')
    expect(requests[0]?.body).toBe('{"page_size":100}')
  })

  it('maps API-retrieve-block-children to GET with pagination query params', async () => {
    const { transport, requests } = makeHttpTransport([{ status: 200, payload: { results: [] } }])
    await transport.callTool('API-retrieve-block-children', {
      block_id: 'b1',
      page_size: 100,
      start_cursor: 'c2',
    })
    expect(requests[0]?.url).toBe('http://mock/v1/blocks/b1/children?page_size=100&start_cursor=c2')
  })

  it('maps API-patch-block-children to PATCH /blocks/{id}/children with the body', async () => {
    const { transport, requests } = makeHttpTransport([{ status: 200, payload: { results: [] } }])
    await transport.callTool('API-patch-block-children', {
      block_id: 'b1',
      children: [{ type: 'paragraph' }],
    })
    expect(requests[0]?.url).toBe('http://mock/v1/blocks/b1/children')
    expect(requests[0]?.method).toBe('PATCH')
    expect(requests[0]?.body).toBe('{"children":[{"type":"paragraph"}]}')
  })

  it('maps API-create-a-comment to POST /comments with the args as JSON body', async () => {
    const { transport, requests } = makeHttpTransport([{ status: 200, payload: { id: 'c1' } }])
    await transport.callTool('API-create-a-comment', { parent: { page_id: 'p1' } })
    expect(requests[0]?.url).toBe('http://mock/v1/comments')
    expect(requests[0]?.method).toBe('POST')
    expect(requests[0]?.body).toBe('{"parent":{"page_id":"p1"}}')
  })

  it('throws NotionAPIError with status and code on HTTP errors', async () => {
    const { transport } = makeHttpTransport([
      { status: 404, payload: { message: 'not found', code: 'object_not_found' } },
    ])
    const err = await transport
      .callTool('API-retrieve-a-page', { page_id: 'x' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NotionAPIError)
    expect((err as NotionAPIError).status).toBe(404)
    expect((err as NotionAPIError).code).toBe('object_not_found')
    expect((err as NotionAPIError).message).toBe('not found')
  })

  it('rejects unsupported tool names', async () => {
    const { transport } = makeHttpTransport([])
    await expect(transport.callTool('API-unknown', {})).rejects.toThrow(/unsupported Notion tool/)
  })
})

it('honors Retry-After and bounds repeated rate limits', async () => {
  vi.useFakeTimers()
  try {
    const { transport, requests } = makeHttpTransport([
      { status: 429, headers: { 'Retry-After': '2' }, payload: { message: 'slow' } },
      { status: 200, payload: { id: 'p' } },
    ])
    const response = transport.callTool('API-retrieve-a-page', { page_id: 'p' })
    await vi.advanceTimersByTimeAsync(1999)
    expect(requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await response).toEqual({ id: 'p' })
    expect(requests).toHaveLength(2)
    const limited = makeHttpTransport(
      Array.from({ length: 4 }, () => ({ status: 429, payload: { message: 'slow' } })),
    )
    const refused = expect(
      limited.transport.callTool('API-retrieve-a-page', { page_id: 'p' }),
    ).rejects.toThrow('slow')
    await vi.runAllTimersAsync()
    await refused
    expect(limited.requests).toHaveLength(4)
  } finally {
    vi.useRealTimers()
  }
})

describe('MemoryOAuthClientProvider', () => {
  it('holds what it is handed and redirects through the callback', async () => {
    const redirects: URL[] = []
    const clientMetadata = { redirect_uris: ['https://example.com/cb'], client_name: 'mirage' }
    const provider = new MemoryOAuthClientProvider({
      clientMetadata,
      redirect: (url) => {
        redirects.push(url)
      },
    })
    expect(provider.clientMetadata).toBe(clientMetadata)
    expect([provider.redirectUrl, provider.tokens(), provider.clientInformation()]).toEqual([
      undefined,
      undefined,
      undefined,
    ])
    expect(() => provider.codeVerifier()).toThrow(/no code verifier/)
    const tokens = { access_token: 'x', token_type: 'Bearer' }
    provider.saveTokens(tokens)
    provider.saveClientInformation({ client_id: 'abc' })
    provider.saveCodeVerifier('v')
    expect([provider.tokens(), provider.clientInformation(), provider.codeVerifier()]).toEqual([
      tokens,
      { client_id: 'abc' },
      'v',
    ])
    provider.clearTokens()
    expect(provider.tokens()).toBeUndefined()
    const url = new URL('https://example.com/authorize')
    await provider.redirectToAuthorization(url)
    expect(redirects).toEqual([url])
    expect(fakeAuthProvider.redirectUrl).toBe('http://localhost/cb')
  })
})

interface OAuthMock {
  base: string
  grants: string[]
  bearers: string[]
  revoke(token: string): void
  close(): Promise<void>
}

/**
 * A Notion-shaped MCP server behind OAuth: protected-resource and
 * authorization-server metadata, dynamic registration, a token endpoint
 * for the code and refresh grants, and an MCP endpoint that answers 401
 * until the request carries a token it issued.
 */
async function startOAuthMock(): Promise<OAuthMock> {
  const grants: string[] = []
  const bearers: string[] = []
  const issued = new Set<string>()
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'notion-mock', version: '1.0.0' })
    server.registerTool(
      'API-retrieve-a-page',
      { inputSchema: z.object({ page_id: z.string() }) },
      (args) => ({
        content: [{ type: 'text', text: JSON.stringify({ object: 'page', id: args.page_id }) }],
      }),
    )
    return server
  })
  let base = ''
  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)
    const path = new URL(req.url ?? '/', base).pathname
    if (path.startsWith('/.well-known/oauth-protected-resource')) {
      json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] })
      return
    }
    if (path === '/.well-known/oauth-authorization-server') {
      json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      })
      return
    }
    if (path === '/register') {
      json(res, 201, { ...(JSON.parse(body.toString()) as object), client_id: 'mirage-client' })
      return
    }
    if (path === '/token') {
      const form = new URLSearchParams(body.toString())
      const grant = form.get('grant_type') ?? ''
      grants.push(grant)
      const ok =
        (grant === 'authorization_code' &&
          form.get('code') === 'the-code' &&
          form.get('code_verifier') !== null) ||
        (grant === 'refresh_token' && form.get('refresh_token') === 'r1')
      if (!ok) {
        json(res, 400, { error: 'invalid_grant' })
        return
      }
      const access = grant === 'authorization_code' ? 'a1' : 'a2'
      issued.add(access)
      json(res, 200, {
        access_token: access,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: grant === 'authorization_code' ? 'r1' : 'r2',
      })
      return
    }
    if (path !== '/mcp') {
      json(res, 404, { error: 'not_found' })
      return
    }
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    bearers.push(bearer)
    if (!issued.has(bearer)) {
      res.writeHead(401, {
        'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
      })
      res.end()
      return
    }
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(name, value)
    }
    const method = req.method ?? 'GET'
    const response = await handler.fetch(
      new Request(`${base}${req.url ?? '/'}`, {
        method,
        headers,
        ...(method === 'POST' ? { body } : {}),
      }),
    )
    res.writeHead(response.status, Object.fromEntries(response.headers))
    if (response.body !== null) {
      for await (const chunk of response.body) res.write(chunk)
    }
    res.end()
  }
  const http = createServer((req, res) => {
    void serve(req, res)
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  base = `http://127.0.0.1:${String(address.port)}`
  return {
    base,
    grants,
    bearers,
    revoke: (token) => issued.delete(token),
    close: async () => {
      await handler.close()
      await new Promise<void>((resolve) =>
        http.close(() => {
          resolve()
        }),
      )
    },
  }
}

async function logIn(
  mock: OAuthMock,
): Promise<{ provider: MemoryOAuthClientProvider; redirects: URL[] }> {
  const redirects: URL[] = []
  const provider = new MemoryOAuthClientProvider({
    clientMetadata: { client_name: 'mirage', redirect_uris: ['http://localhost/cb'] },
    redirectUrl: 'http://localhost/cb',
    redirect: (url) => {
      redirects.push(url)
    },
  })
  const first = new MCPNotionTransport({ authProvider: provider, serverUrl: `${mock.base}/mcp` })
  await expect(first.callTool('API-retrieve-a-page', { page_id: 'p1' })).rejects.toThrow()
  const outcome = await auth(provider, {
    serverUrl: `${mock.base}/mcp`,
    authorizationCode: 'the-code',
  })
  expect(outcome).toBe('AUTHORIZED')
  return { provider, redirects }
}

describe('MCPNotionTransport over OAuth', () => {
  it('redirects to authorize, exchanges the code, then calls the tool', async () => {
    const mock = await startOAuthMock()
    try {
      const { provider, redirects } = await logIn(mock)
      expect(redirects).toHaveLength(1)
      const url = redirects[0]
      if (url === undefined) throw new Error('no redirect')
      expect(`${url.origin}${url.pathname}`).toBe(`${mock.base}/authorize`)
      expect(url.searchParams.get('client_id')).toBe('mirage-client')
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      expect(url.searchParams.get('redirect_uri')).toBe('http://localhost/cb')
      expect(provider.tokens()?.access_token).toBe('a1')
      const transport = new MCPNotionTransport({
        authProvider: provider,
        serverUrl: `${mock.base}/mcp`,
      })
      expect(await transport.callTool('API-retrieve-a-page', { page_id: 'p1' })).toEqual({
        object: 'page',
        id: 'p1',
      })
      expect(mock.bearers.at(-1)).toBe('a1')
      expect(mock.grants).toEqual(['authorization_code'])
    } finally {
      await mock.close()
    }
  })

  it('refreshes an expired token and retries', async () => {
    const mock = await startOAuthMock()
    try {
      const { provider, redirects } = await logIn(mock)
      mock.revoke('a1')
      const transport = new MCPNotionTransport({
        authProvider: provider,
        serverUrl: `${mock.base}/mcp`,
      })
      expect(await transport.callTool('API-retrieve-a-page', { page_id: 'p2' })).toEqual({
        object: 'page',
        id: 'p2',
      })
      expect(mock.grants).toEqual(['authorization_code', 'refresh_token'])
      expect(provider.tokens()?.access_token).toBe('a2')
      expect(redirects).toHaveLength(1)
    } finally {
      await mock.close()
    }
  })
})
