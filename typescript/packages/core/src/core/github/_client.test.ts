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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitHubApiError, HttpGitHubTransport } from './_client.ts'

interface Seen {
  url: string
  method: string
  body: string | null
  contentType: string | null
}

const SEEN: Seen[] = []
let REPLY: { status: number; body: string } = { status: 200, body: '{"ok":true}' }
const REAL_FETCH = globalThis.fetch

function transport(): HttpGitHubTransport {
  return new HttpGitHubTransport({ token: 't', baseUrl: 'https://api.example.test' })
}

beforeEach(() => {
  SEEN.length = 0
  REPLY = { status: 200, body: '{"ok":true}' }
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    SEEN.push({
      url: req.url,
      method: req.method,
      body: typeof init?.body === 'string' ? init.body : null,
      contentType: req.headers.get('content-type'),
    })
    return Promise.resolve(
      new Response(REPLY.body === '' ? null : REPLY.body, {
        status: REPLY.status,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }) as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = REAL_FETCH
})

describe('HttpGitHubTransport', () => {
  it('puts params on the query string and leaves the body off a GET', async () => {
    await transport().get('/repos/o/r/git/trees/main', { recursive: '1' })
    expect(SEEN[0]?.url).toBe('https://api.example.test/repos/o/r/git/trees/main?recursive=1')
    expect(SEEN[0]?.body).toBeNull()
  })

  it('sends a body as JSON on a method that carries one', async () => {
    await transport().request('PATCH', '/repos/o/r', { name: 'after' })
    expect(SEEN[0]?.method).toBe('PATCH')
    expect(SEEN[0]?.body).toBe('{"name":"after"}')
    expect(SEEN[0]?.contentType).toContain('application/json')
  })

  // Real gh sends nothing for a fieldless call; an empty JSON object plus a
  // content type is a different request, and some endpoints read it as one.
  it('sends no body and no content type when there is nothing to send', async () => {
    await transport().request('DELETE', '/repos/o/r')
    expect(SEEN[0]?.method).toBe('DELETE')
    expect(SEEN[0]?.body).toBeNull()
    expect(SEEN[0]?.contentType).toBeNull()
  })

  // Octokit reads `{...}` in a url as a route-template placeholder and drops
  // the segment when nothing fills it -- silently, with no error. `gh api`
  // takes its endpoint straight from the agent, so a brace must survive as
  // one rather than deleting the path segment it sits in.
  it('keeps a braced path segment instead of letting it vanish', async () => {
    await transport().get('/repos/o/r/contents/{tmpl}')
    expect(SEEN[0]?.url).toBe('https://api.example.test/repos/o/r/contents/%7Btmpl%7D')
  })

  it('percent-encodes a space in a path', async () => {
    await transport().get('/repos/o/r/contents/my file.txt')
    expect(SEEN[0]?.url).toBe('https://api.example.test/repos/o/r/contents/my%20file.txt')
  })

  // 204 and an empty 202 have no body; the caller gets null on a call that
  // worked, not the empty string octokit reports.
  it('decodes an empty response to null', async () => {
    REPLY = { status: 204, body: '' }
    expect(await transport().request('DELETE', '/repos/o/r')).toBeNull()
  })

  // github.com asks for a second between writes and enforces it as a
  // secondary rate limit; a self-hosted host or a fake imposes no such thing,
  // and paying it there costs a second per written file for nothing.
  it('does not hold writes a second apart against a non-github.com host', async () => {
    const started = Date.now()
    const t = transport()
    await t.request('PUT', '/repos/o/r/contents/a')
    await t.request('PUT', '/repos/o/r/contents/b')
    await t.request('PUT', '/repos/o/r/contents/c')
    expect(Date.now() - started).toBeLessThan(500)
    expect(SEEN).toHaveLength(3)
  })

  // Octokit merges loose parameters into the same object that carries
  // `url`, `method` and `headers`, so a field the agent typed could steer
  // the request instead of riding in it: `gh api X -f url=...` retargeted
  // the call. Body and query travel in their own containers.
  it('does not let a field named url steer the request', async () => {
    await transport().request('POST', '/repos/o/r/issues', {
      url: 'https://elsewhere.test/x',
      method: 'DELETE',
      title: 'hi',
    })
    expect(SEEN[0]?.url).toBe('https://api.example.test/repos/o/r/issues')
    expect(SEEN[0]?.method).toBe('POST')
    expect(JSON.parse(SEEN[0]?.body ?? '{}')).toEqual({
      url: 'https://elsewhere.test/x',
      method: 'DELETE',
      title: 'hi',
    })
  })

  it('does not let a query field named url steer the request', async () => {
    await transport().get('/search/code', { url: 'https://elsewhere.test/x', q: 'a' })
    expect(SEEN[0]?.url).toBe(
      'https://api.example.test/search/code?url=https%3A%2F%2Felsewhere.test%2Fx&q=a',
    )
  })

  it('reports a failure as a GitHubApiError carrying the status', async () => {
    REPLY = { status: 404, body: '{"message":"Not Found"}' }
    await expect(transport().get('/repos/o/r')).rejects.toMatchObject({
      constructor: GitHubApiError,
      status: 404,
      message: 'Not Found',
    })
  })
})
