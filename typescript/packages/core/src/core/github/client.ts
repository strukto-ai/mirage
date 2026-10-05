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

import { Octokit } from '@octokit/core'
import { RequestError } from '@octokit/request-error'
import { retry } from '@octokit/plugin-retry'
import { throttling } from '@octokit/plugin-throttling'
import { GRAPHQL_PATH, SEARCH_PAGE_SIZE } from './constants.ts'

export const GITHUB_API_BASE = 'https://api.github.com'
export const GITHUB_API_VERSION = '2022-11-28'
// A rate limit is a wait, not a failure, but an unbounded wait is a hang;
// three attempts is what octokit's own docs use for an unattended client.
// The count rides plugin-retry's own options rather than every request's:
// its limiter re-sends any failed request whose options carry a count, so a
// count there sent a 404 or a 422 four times over before reporting it.
const GITHUB_RETRIES = 3
// The statuses plugin-retry leaves alone: its own list, plus 500. Octokit
// reports a request that got no response at all as a 500, so retrying 500
// spent 14 s on a refused connection before failing anyway, and a real 500
// is no more worth a retry: gh retries neither.
const NO_RETRY_STATUSES = [400, 401, 403, 404, 410, 422, 451, 500]
// The resolver's codes for a host that does not resolve.
const DNS_FAILURES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME'])

export interface GitHubTransport {
  get(path: string, params?: Record<string, string>): Promise<unknown>
  request(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string>,
    headers?: Record<string, string>,
  ): Promise<unknown>
  requestWithResponse?(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string>,
    headers?: Record<string, string>,
  ): Promise<GitHubResponse>
}

export interface GitHubResponse {
  data: unknown
  status: number
  headers: Record<string, string>
}

const Kit = Octokit.plugin(retry, throttling)

/**
 * Octokit reads `{name}` in a url as a route-template placeholder, and a path's
 * `:name` as the legacy spelling of one, and drops either when nothing fills
 * it, silently and without an error. Every caller here passes a path that is
 * already final -- `gh api` takes one straight from the agent's command line,
 * and `compare/main...owner:branch` loses its owner's branch. Escape braces,
 * query colons and every path colon Octokit would read before it can.
 *
 * Args:
 *   path (string): the request path as the caller spelled it.
 *
 * Returns:
 *   string: braces and those colons percent-encoded, preserving the URL scheme.
 */
function escapeRoute(path: string): string {
  const escaped = path.replace(/\{/g, '%7B').replace(/\}/g, '%7D')
  const query = escaped.indexOf('?')
  const route = query < 0 ? escaped : escaped.slice(0, query)
  const rest = query < 0 ? '' : `?${escaped.slice(query + 1).replace(/:/g, '%3A')}`
  return route.replace(/:(?=[a-z]\w)/g, '%3A') + rest
}

/**
 * The GraphQL endpoint of the install whose REST base is `baseUrl`.
 *
 * gh pairs the two by host (internal/ghinstance, GraphQLEndpoint and
 * RESTPrefix): github.com serves REST at https://api.github.com/ and GraphQL
 * at https://api.github.com/graphql, while a GitHub Enterprise Server serves
 * REST at https://HOST/api/v3/ and GraphQL at https://HOST/api/graphql, which
 * is not under the REST base. Octokit's own graphql client draws the same
 * line.
 *
 * Args:
 *   baseUrl (string): the REST base the install is configured with.
 *
 * Returns:
 *   string: the URL GraphQL queries are posted to.
 */
export function graphqlUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  return base.endsWith('/api/v3') ? `${base.slice(0, -'/v3'.length)}/graphql` : `${base}/graphql`
}

export class HttpGitHubTransport implements GitHubTransport {
  readonly baseUrl: string
  private readonly kit: InstanceType<typeof Kit>

  constructor(opts: { token: string; baseUrl?: string }) {
    this.baseUrl = opts.baseUrl ?? GITHUB_API_BASE
    this.kit = new Kit({
      auth: opts.token,
      baseUrl: this.baseUrl,
      retry: { retries: GITHUB_RETRIES, doNotRetry: NO_RETRY_STATUSES },
      throttle: {
        // The write limiter holds every non-GET a second apart, which is
        // github.com's own guidance and its secondary rate limit. That limit
        // is github.com's, not the API's: a GHES install does not impose it
        // and a fake certainly does not, so paying it there would add a
        // second per write for nothing.
        enabled: this.baseUrl === GITHUB_API_BASE,
        onRateLimit: (_after: number, _options: unknown, _kit: unknown, count: number) =>
          count < GITHUB_RETRIES,
        onSecondaryRateLimit: (_after: number, _options: unknown, _kit: unknown, count: number) =>
          count < GITHUB_RETRIES,
      },
    })
  }

  get(path: string, params?: Record<string, string>): Promise<unknown> {
    return this.request('GET', path, undefined, params)
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string>,
    headers?: Record<string, string>,
  ): Promise<unknown> {
    return (await this.requestWithResponse(method, path, body, params, headers)).data
  }

  async requestWithResponse(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string>,
    headers?: Record<string, string>,
  ): Promise<GitHubResponse> {
    let failed: Response | undefined
    try {
      // Octokit reads loose parameters off the same object that carries
      // `url`, `method` and `headers`, so a field the agent typed would
      // steer the request rather than ride in it: `gh api X -f url=...`
      // retargeted the call. The query is spelled into the url and the body
      // travels as `data`, which octokit sends verbatim, so neither can
      // collide with a transport option. A call with neither sends no body
      // at all, which is what a bare DELETE has to look like on the wire.
      const query = new URLSearchParams(params ?? {}).toString()
      const target = path === GRAPHQL_PATH ? graphqlUrl(this.baseUrl) : path
      const r = await this.kit.request({
        method: method.toUpperCase(),
        url:
          escapeRoute(target) + (query === '' ? '' : `${target.includes('?') ? '&' : '?'}${query}`),
        headers: { 'X-GitHub-Api-Version': GITHUB_API_VERSION, ...headers },
        request: {
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            failed = undefined
            const response = await globalThis.fetch(input, init)
            if (response.status >= 400) failed = response.clone()
            return response
          },
        },
        ...(body === undefined ? {} : { data: body }),
      })
      // 204 and an empty 202 decode to '' rather than a body; the caller gets
      // null on a call that worked. A binary body, such as a run's log
      // archive, arrives as an ArrayBuffer and is handed on as bytes.
      const responseHeaders: Record<string, string> = {}
      for (const [key, value] of Object.entries(r.headers)) {
        if (value !== undefined) responseHeaders[key.toLowerCase()] = String(value)
      }
      return {
        data:
          r.data === '' ? null : r.data instanceof ArrayBuffer ? new Uint8Array(r.data) : r.data,
        status: r.status,
        headers: responseHeaders,
      }
    } catch (err) {
      if (err instanceof RequestError) {
        // Octokit composes its message as `<message> - <documentation_url>`.
        // The suffix is octokit's, not GitHub's: the service says only the
        // message, real gh prints only the message, and the python client
        // reports only the message. Read it off the body rather than
        // trimming the composed string. The body itself travels verbatim,
        // since `gh api` prints it.
        if (err.response === undefined) throw connectionError(err)
        if (failed === undefined) throw new GitHubApiError(err.message, err.status)
        const body = await failed.text()
        throw new GitHubApiError(
          apiMessage(body, failed.statusText),
          err.status,
          body,
          failed.url || err.request.url,
          headersOf(failed.headers),
        )
      }
      throw err
    }
  }
}

/** A response's headers, lowercased, as a transport reports them. */
function headersOf(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of headers) out[key.toLowerCase()] = value
  return out
}

/**
 * The error for a call that got no response at all, worded as gh words it.
 * A host that does not resolve reads "error connecting to HOST" with a
 * pointer at GitHub's status page (gh's `printError`), a refused connection
 * reads as Go's client reports one, `Get "URL": dial tcp ADDR: connect:
 * connection refused`, and anything else as the transport said it.
 */
function connectionError(err: RequestError): GitHubConnectionError {
  const reason = (
    err.cause as { cause?: { code?: unknown; address?: unknown; port?: unknown } } | undefined
  )?.cause
  const code = typeof reason?.code === 'string' ? reason.code : ''
  if (code === 'ECONNREFUSED' && typeof reason?.address === 'string') {
    const method = err.request.method
    const verb = method.charAt(0) + method.slice(1).toLowerCase()
    const address = reason.address.includes(':') ? `[${reason.address}]` : reason.address
    return new GitHubConnectionError(
      `${verb} "${err.request.url}": dial tcp ${address}:${String(reason.port)}: connect: connection refused`,
    )
  }
  if (!DNS_FAILURES.has(code)) return new GitHubConnectionError(err.message)
  let host = ''
  try {
    host = new URL(err.request.url).hostname
  } catch (parse) {
    if (!(parse instanceof TypeError)) throw parse
    host = err.request.url
  }
  return new GitHubConnectionError(
    `error connecting to ${host}\ncheck your internet connection or https://githubstatus.com`,
  )
}

/**
 * A GitHub call that got no response: the connection was refused, the host
 * did not resolve, or the transport failed before any status arrived. It is
 * not a `GitHubApiError`, because there is no status to report, and it is
 * never retried.
 */
export class GitHubConnectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitHubConnectionError'
  }
}

/** A response body decoded as JSON, the text itself when it is not JSON. */
function decodedBody(body: string): unknown {
  if (body === '') return null
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

/**
 * GitHub's own wording for a failure, or the status reason, the twin of
 * python's `_api_message`.
 */
function apiMessage(body: string, reason: string): string {
  const data = decodedBody(body)
  const message =
    typeof data === 'object' && data !== null ? (data as { message?: unknown }).message : undefined
  return typeof message === 'string' ? message : reason || body
}

/**
 * A GitHub call that answered with a status the caller cannot use.
 *
 * `body` is the response text as it arrived, `data` that text decoded (the
 * text itself when it is not JSON), `url` the final request URL, query
 * included, and `headers` the response's, lowercased, which `gh api -i`
 * prints for a failing response as for any other.
 */
export class GitHubApiError extends Error {
  readonly status: number
  readonly body: string
  readonly url: string
  readonly data: unknown
  readonly headers: Record<string, string>
  constructor(
    message: string,
    status: number,
    body = '',
    url = '',
    headers: Record<string, string> = {},
  ) {
    super(message)
    this.name = 'GitHubApiError'
    this.status = status
    this.body = body
    this.url = url
    this.data = decodedBody(body)
    this.headers = headers
  }
}

export interface GitHubTreeItem {
  path: string
  type: 'blob' | 'tree' | 'commit'
  sha: string
  size?: number
}

interface GitHubBlob {
  content: string
  encoding: string
  sha: string
  size: number
}

export interface GitHubRepoInfo {
  default_branch: string
}

export async function fetchRepoInfo(
  transport: GitHubTransport,
  owner: string,
  repo: string,
): Promise<GitHubRepoInfo> {
  const data = (await transport.get(`/repos/${owner}/${repo}`)) as GitHubRepoInfo
  return data
}

export async function fetchBlob(
  transport: GitHubTransport,
  owner: string,
  repo: string,
  sha: string,
): Promise<Uint8Array> {
  const data = (await transport.get(`/repos/${owner}/${repo}/git/blobs/${sha}`)) as GitHubBlob
  if (data.encoding !== 'base64') {
    throw new GitHubApiError(`unexpected blob encoding: ${data.encoding}`, 0)
  }
  const bin = atob(data.content.replace(/\n/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export interface GitHubCodeSearchResult {
  path: string
  sha: string
}

export interface GitHubCodeSearch {
  results: GitHubCodeSearchResult[]
  truncated: boolean
}

// The literal is sent verbatim, so the answer has to vouch for itself: an
// item is kept only when its repository.full_name names this repository
// (compared case-insensitively, as GitHub resolves `repo:`), and the answer is
// complete only when incomplete_results is false and total_count is an
// integer no larger than the rows returned. A missing or malformed field
// counts against it, which costs a full scan and never a missed file.
export async function searchCode(
  transport: GitHubTransport,
  owner: string,
  repo: string,
  query: string,
  pathFilter?: string,
): Promise<GitHubCodeSearch> {
  let q = `${query} repo:${owner}/${repo}`
  if (pathFilter !== undefined && pathFilter !== '') q += ` path:${pathFilter}`
  const data = (await transport.get(`/search/code`, {
    q,
    per_page: String(SEARCH_PAGE_SIZE),
  })) as {
    total_count?: unknown
    incomplete_results?: unknown
    items?: { path: string; sha: string; repository?: { full_name?: unknown } | null }[] | null
  }
  const items = data.items ?? []
  const total = data.total_count
  const complete =
    data.incomplete_results === false &&
    typeof total === 'number' &&
    Number.isInteger(total) &&
    total <= items.length
  const want = `${owner}/${repo}`.toLowerCase()
  const results: GitHubCodeSearchResult[] = []
  for (const it of items) {
    const name = it.repository?.full_name
    if (typeof name === 'string' && name.toLowerCase() === want) {
      results.push({ path: it.path, sha: it.sha })
    }
  }
  return { results, truncated: !complete }
}
