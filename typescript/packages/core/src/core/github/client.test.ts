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
import {
  GitHubApiError,
  GitHubConnectionError,
  type GitHubTransport,
  graphqlUrl,
  HttpGitHubTransport,
} from './client.ts'
import { searchCode } from './client.ts'
import { fetchDirTree, fetchDirPage, fetchTree } from './tree.ts'

interface Seen {
  url: string
  method: string
  body: string | null
  contentType: string | null
  accept: string | null
}

const SEEN: Seen[] = []
let REPLY: { status: number; body: string; reason?: string } = {
  status: 200,
  body: '{"ok":true}',
}
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
      accept: req.headers.get('accept'),
    })
    return Promise.resolve(
      new Response(REPLY.body === '' ? null : REPLY.body, {
        status: REPLY.status,
        statusText: REPLY.reason ?? '',
        headers: { 'content-type': 'application/json', 'x-page': 'next' },
      }),
    )
  }) as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = REAL_FETCH
})

// gh's GraphQLEndpoint beside its RESTPrefix (cli/cli internal/ghinstance):
// an Enterprise Server serves GraphQL at /api/graphql, outside /api/v3.
describe('graphqlUrl', () => {
  it.each([
    ['https://api.github.com', 'https://api.github.com/graphql'],
    ['https://ghe.example/api/v3', 'https://ghe.example/api/graphql'],
    ['https://ghe.example/api/v3/', 'https://ghe.example/api/graphql'],
    ['http://127.0.0.1:5098', 'http://127.0.0.1:5098/graphql'],
    ['http://127.0.0.1:5098/api/v3x', 'http://127.0.0.1:5098/api/v3x/graphql'],
  ])('%s answers GraphQL at %s', (base, url) => {
    expect(graphqlUrl(base)).toBe(url)
  })

  it('sends a GraphQL query outside an Enterprise REST base', async () => {
    // A slash-led `/graphql` is a REST path, as `gh api /graphql` is in gh.
    const ghes = new HttpGitHubTransport({ token: 't', baseUrl: 'https://ghe.example/api/v3' })
    await ghes.request('POST', 'graphql', { query: '{ viewer { login } }' })
    await ghes.get('/repos/o/r')
    await ghes.get('/graphql')
    expect(SEEN.map((seen) => `${seen.method} ${seen.url}`)).toEqual([
      'POST https://ghe.example/api/graphql',
      'GET https://ghe.example/api/v3/repos/o/r',
      'GET https://ghe.example/api/v3/graphql',
    ])
  })
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

  // The same for a path's `:name`, Octokit's legacy placeholder: the head of
  // `main...owner:branch` lost `:branch` and asked for another comparison.
  it('keeps a colon in a path instead of reading it as a placeholder', async () => {
    await transport().get('/repos/o/r/compare/main...fork-owner:feature')
    expect(SEEN[0]?.url).toBe(
      'https://api.example.test/repos/o/r/compare/main...fork-owner%3Afeature',
    )
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

  it('retains response metadata and accepts custom headers', async () => {
    const response = await transport().requestWithResponse(
      'GET',
      '/repos/o/r',
      undefined,
      undefined,
      {
        accept: 'text/plain',
      },
    )
    expect(SEEN[0]?.accept).toBe('text/plain')
    expect(response).toMatchObject({ data: { ok: true }, status: 200 })
    expect(response.headers['x-page']).toBe('next')
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

  // A status no retry is for is asked once: a retry count on every request
  // made plugin-retry's limiter send a 404 or a 422 four times over.
  it.each([404, 422])('sends a request that answers %i once', async (status) => {
    REPLY = { status, body: '{"message":"no"}' }
    await expect(transport().get('/repos/o/r')).rejects.toMatchObject({ status })
    expect(SEEN).toHaveLength(1)
  })

  // `gh api -i` prints a failing response's headers as it prints any other's.
  it("carries a failing response's headers", async () => {
    REPLY = { status: 404, body: '{"message":"Not Found"}' }
    await expect(transport().get('/repos/o/r')).rejects.toMatchObject({
      headers: { 'content-type': 'application/json', 'x-page': 'next' },
    })
  })

  // gh retries no server error, and a retried 500 is what a refused
  // connection used to cost: three waits, 14 s, before failing anyway.
  it('does not retry a 500', async () => {
    REPLY = { status: 500, body: '{"message":"Server Error"}' }
    await expect(transport().get('/repos/o/r')).rejects.toMatchObject({ status: 500 })
    expect(SEEN).toHaveLength(1)
  })

  it('hands a binary body back as bytes', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(new Uint8Array([0x50, 0x4b, 0x05, 0x06]), {
          headers: { 'content-type': 'application/zip' },
        }),
      ),
    ) as typeof globalThis.fetch
    expect(await transport().get('/repos/o/r/actions/runs/1/logs')).toEqual(
      new Uint8Array([0x50, 0x4b, 0x05, 0x06]),
    )
  })
})

// A call that got no response is no status at all: gh names the failure and
// exits at once. Measured against gh 2.85 (2026-09-30): an unknown host reads
// as its printError words it, a refused connection as Go's client reports it.
describe('a call that gets no response', () => {
  function refuse(code: string, extra: Record<string, unknown> = {}): void {
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init)
      SEEN.push({ url: req.url, method: req.method, body: null, contentType: null, accept: null })
      const cause = Object.assign(new Error(`connect ${code}`), { code, ...extra })
      return Promise.reject(new TypeError('fetch failed', { cause }))
    }) as typeof globalThis.fetch
  }

  it('names a refused connection as Go does, without a retry', async () => {
    refuse('ECONNREFUSED', { address: '127.0.0.1', port: 19773 })
    const failure = transport().get('/repos/o/r', { per_page: '1' })
    await expect(failure).rejects.toThrow(GitHubConnectionError)
    await expect(failure).rejects.toThrow(
      'Get "https://api.example.test/repos/o/r?per_page=1": dial tcp 127.0.0.1:19773: connect: connection refused',
    )
    expect(SEEN).toHaveLength(1)
  })

  it('names a host that does not resolve as gh does', async () => {
    refuse('ENOTFOUND')
    await expect(transport().request('POST', '/repos/o/r/issues', {})).rejects.toThrow(
      'error connecting to api.example.test\ncheck your internet connection or https://githubstatus.com',
    )
  })

  it('reports any other failure as the transport words it', async () => {
    refuse('ECONNRESET')
    await expect(transport().get('/repos/o/r')).rejects.toThrow('connect ECONNRESET')
  })
})

it.each([
  'repo:theonion/fartscroll.js+created:2014-09-22',
  'user:theonion',
  'org%3Atheonion',
  'repo:owner/repo+is:issue+label:bug',
])('preserves search qualifiers in an endpoint query: %s', async (query) => {
  await transport().get(`/search/issues?q=${query}`)
  expect(new URL(SEEN[0]?.url ?? '').searchParams.get('q')).toBe(
    new URLSearchParams(`q=${query}`).get('q'),
  )
})

// Twin of the search_code tests in python/tests/core/github/test_search.py.
describe('searchCode', () => {
  type Item = Record<string, unknown>

  function stub(
    body: Record<string, unknown>,
    seen: Record<string, string>[] = [],
  ): GitHubTransport {
    return {
      get(_path: string, params?: Record<string, string>): Promise<unknown> {
        seen.push(params ?? {})
        return Promise.resolve(body)
      },
      request(): Promise<unknown> {
        throw new Error('unexpected request')
      },
    }
  }

  function item(path: string, fullName: unknown): Item {
    return { path, sha: path, repository: { full_name: fullName } }
  }

  function body(items: Item[], total?: unknown): Record<string, unknown> {
    return { total_count: total ?? items.length, incomplete_results: false, items }
  }

  it('asks for the largest page', async () => {
    // The default page is 30 rows, and a first page read as the whole
    // answer silently narrows grep to 30 files.
    const seen: Record<string, string>[] = []
    await searchCode(stub(body([]), seen), 'acme', 'proj', 'needle')
    expect(seen[0]?.per_page).toBe('100')
  })

  it('keeps only the mounted repository', async () => {
    // The pattern is sent verbatim, so a qualifier inside it can rescope the
    // search; a fork shares the repository name and a prefix is not a match.
    const out = await searchCode(
      stub(
        body([
          item('src/a.py', 'acme/proj'),
          item('src/a.py', 'other/x'),
          item('src/a.py', 'other/proj'),
          item('src/a.py', 'acme/other'),
          item('src/a.py', 'acme/proj-fork'),
        ]),
      ),
      'acme',
      'proj',
      'needle',
    )
    expect(out.results).toEqual([{ path: 'src/a.py', sha: 'src/a.py' }])
  })

  it.each([
    ['Acme/Proj', 'acme', 'proj'],
    ['acme/proj', 'Acme', 'Proj'],
  ])('compares %s with %s/%s case-insensitively', async (fullName, owner, repo) => {
    const out = await searchCode(stub(body([item('src/a.py', fullName)])), owner, repo, 'needle')
    expect(out.results.map((r) => r.path)).toEqual(['src/a.py'])
  })

  it.each<[string, Item]>([
    ['no repository', { path: 'src/a.py', sha: 'x' }],
    ['a null repository', { path: 'src/a.py', sha: 'x', repository: null }],
    ['an empty repository', { path: 'src/a.py', sha: 'x', repository: {} }],
    ['a null full_name', item('src/a.py', null)],
    ['a numeric full_name', item('src/a.py', 123)],
  ])('drops an item with %s, without throwing', async (_label, entry) => {
    // Nothing vouches for such an item, and dropping it must not throw: a
    // throw inside narrowPaths voids the whole narrowing.
    const out = await searchCode(stub(body([entry])), 'acme', 'proj', 'needle')
    expect(out.results).toEqual([])
  })

  it.each<[string, Record<string, unknown>, boolean]>([
    ['a count equal to the rows', { total_count: 1, incomplete_results: false }, false],
    ['a count below the rows', { total_count: 0, incomplete_results: false }, false],
    ['a count above the rows', { total_count: 2, incomplete_results: false }, true],
    ['incomplete results', { total_count: 1, incomplete_results: true }, true],
    ['no count', { incomplete_results: false }, true],
    ['a string count', { total_count: '1', incomplete_results: false }, true],
    ['a boolean count', { total_count: true, incomplete_results: false }, true],
    ['a fractional count', { total_count: 0.5, incomplete_results: false }, true],
    ['no incomplete flag', { total_count: 1 }, true],
  ])('reports %s as truncated=%s', async (_label, head, truncated) => {
    // Only an answer that says it is complete, with a count no larger than
    // the rows it carries, is the whole set; anything else is truncated.
    const out = await searchCode(
      stub({ ...head, items: [item('src/a.py', 'acme/proj')] }),
      'acme',
      'proj',
      'needle',
    )
    expect(out.truncated).toBe(truncated)
  })

  it('reads null items as no rows', async () => {
    const out = await searchCode(
      stub({ total_count: 0, incomplete_results: false, items: null }),
      'acme',
      'proj',
      'needle',
    )
    expect(out).toEqual({ results: [], truncated: false })
  })

  it('judges completeness before filtering', async () => {
    // total_count counts every row the search matched, foreign ones too.
    const out = await searchCode(
      stub(body([item('src/a.py', 'acme/proj'), item('src/b.py', 'other/x')])),
      'acme',
      'proj',
      'needle',
    )
    expect(out.results.map((r) => r.path)).toEqual(['src/a.py'])
    expect(out.truncated).toBe(false)
  })
})

describe('tree reference encoding', () => {
  it.each(['feature/topic', 'release#1', 'literal%2Fref', 'feature/topic:docs/nested'])(
    'preserves %s in recursive and directory requests',
    async (ref) => {
      REPLY = { status: 200, body: '{"tree":[],"truncated":false}' }
      const client = transport()
      await fetchTree(client, 'o', 'r', ref)
      await fetchDirPage(client, 'o', 'r', ref)
      await fetchDirTree(client, 'o', 'r', ref)
      expect(SEEN.map(({ url }) => url)).toEqual([
        `https://api.example.test/repos/o/r/git/trees/${encodeURIComponent(ref)}?recursive=1`,
        `https://api.example.test/repos/o/r/git/trees/${encodeURIComponent(ref)}`,
        `https://api.example.test/repos/o/r/git/trees/${encodeURIComponent(ref)}`,
      ])
    },
  )
})

describe('fetchDirPage', () => {
  it('carries truncation and drops gitlinks', async () => {
    const transport = {
      get: () =>
        Promise.resolve({
          truncated: true,
          tree: [
            { path: 'a.py', type: 'blob', sha: 'a', size: 1 },
            { path: 'vendor', type: 'commit', sha: 'c' },
          ],
        }),
    } as unknown as GitHubTransport
    const page = await fetchDirPage(transport, 'o', 'r', 'sha')
    expect(page.truncated).toBe(true)
    // A gitlink has no blob and no size; the page drops it like the tree.
    expect(page.tree.map((item) => item.path)).toEqual(['a.py'])
  })

  it('refuses, through fetchDirTree, a directory GitHub cut short', async () => {
    // The fallback walk caches what it gets as the whole directory; a name
    // past GitHub's cut would read as absent, and a fresh probe as gone.
    const reply = (truncated: boolean) =>
      ({
        get: () =>
          Promise.resolve({ truncated, tree: [{ path: 'a.py', type: 'blob', sha: 'a', size: 1 }] }),
      }) as unknown as GitHubTransport
    expect(await fetchDirTree(reply(false), 'o', 'r', 'sha')).toHaveLength(1)
    const err = await fetchDirTree(reply(true), 'o', 'r', 'sha').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitHubApiError)
    expect((err as GitHubApiError).message).toContain('truncated the tree listing')
  })
})

it.each([
  [
    ' {"message":"Validation Failed", "errors":[{"message":"bad query"}]}\n',
    { message: 'Validation Failed', errors: [{ message: 'bad query' }] },
    'Validation Failed',
  ],
  ['upstream unavailable\n', 'upstream unavailable\n', 'Unprocessable Entity'],
  ['', null, 'Unprocessable Entity'],
])('preserves an error response body and request URL: %s', async (body, data, message) => {
  REPLY = { status: 422, body, reason: 'Unprocessable Entity' }
  await expect(
    transport().request('GET', '/search/issues', undefined, { q: 'bad query' }),
  ).rejects.toMatchObject({
    status: 422,
    message,
    body,
    data,
    url: 'https://api.example.test/search/issues?q=bad+query',
  })
})
