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

export const GITHUB_API_BASE = 'https://api.github.com'
export const GITHUB_API_VERSION = '2022-11-28'
// A rate limit is a wait, not a failure, but an unbounded wait is a hang;
// three attempts is what octokit's own docs use for an unattended client.
const GITHUB_RETRIES = 3

export interface GitHubTransport {
  get(path: string, params?: Record<string, string>): Promise<unknown>
  request(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string>,
  ): Promise<unknown>
}

const Kit = Octokit.plugin(retry, throttling)

/**
 * Octokit reads `{name}` in a url as a route-template placeholder and drops
 * the segment when nothing fills it, silently and without an error. Every
 * caller here passes a path that is already final -- `gh api` takes one
 * straight from the agent's command line -- so the braces are escaped to
 * the percent forms a server sees them as.
 *
 * Args:
 *   path (string): the request path as the caller spelled it.
 *
 * Returns:
 *   string: the path with `{` and `}` percent-encoded.
 */
function escapeBraces(path: string): string {
  return path.replace(/\{/g, '%7B').replace(/\}/g, '%7D')
}

export class HttpGitHubTransport implements GitHubTransport {
  readonly baseUrl: string
  private readonly kit: InstanceType<typeof Kit>

  constructor(opts: { token: string; baseUrl?: string }) {
    this.baseUrl = opts.baseUrl ?? GITHUB_API_BASE
    this.kit = new Kit({
      auth: opts.token,
      baseUrl: this.baseUrl,
      request: { retries: GITHUB_RETRIES },
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
  ): Promise<unknown> {
    try {
      // Octokit routes a parameter by method the way gh does: query string on
      // GET, JSON body otherwise. A call with neither sends no body at all,
      // which is what a bare DELETE has to look like on the wire.
      const r = await this.kit.request({
        method: method.toUpperCase(),
        url: escapeBraces(path),
        headers: { 'X-GitHub-Api-Version': GITHUB_API_VERSION },
        ...(params ?? {}),
        ...((body as Record<string, unknown> | undefined) ?? {}),
      })
      // 204 and an empty 202 decode to '' rather than a body; the caller gets
      // null on a call that worked.
      return r.data === '' ? null : r.data
    } catch (err) {
      if (err instanceof RequestError) {
        // Octokit composes its message as `<message> - <documentation_url>`.
        // The suffix is octokit's, not GitHub's: the service says only the
        // message, real gh prints only the message, and the python client
        // reports only the message. Read it off the body rather than
        // trimming the composed string.
        const data = err.response?.data as { message?: string } | undefined
        const message = typeof data?.message === 'string' ? data.message : err.message
        throw new GitHubApiError(message, err.status)
      }
      throw err
    }
  }
}

export class GitHubApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'GitHubApiError'
    this.status = status
  }
}

export interface GitHubTreeItem {
  path: string
  type: 'blob' | 'tree' | 'commit'
  sha: string
  size?: number
}

export interface GitHubBlob {
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

export async function fetchTree(
  transport: GitHubTransport,
  owner: string,
  repo: string,
  ref: string,
): Promise<{ tree: GitHubTreeItem[]; truncated: boolean }> {
  const data = (await transport.get(`/repos/${owner}/${repo}/git/trees/${ref}`, {
    recursive: '1',
  })) as { tree?: GitHubTreeItem[]; truncated?: boolean }
  return { tree: dropSubmodules(data.tree ?? []), truncated: data.truncated === true }
}

// Submodule gitlinks (type "commit") have no size and no blob to read;
// exclude them from the tree entirely.
function dropSubmodules(tree: GitHubTreeItem[]): GitHubTreeItem[] {
  return tree.filter((item) => item.type !== 'commit')
}

export async function fetchDirTree(
  transport: GitHubTransport,
  owner: string,
  repo: string,
  treeSha: string,
): Promise<GitHubTreeItem[]> {
  const data = (await transport.get(`/repos/${owner}/${repo}/git/trees/${treeSha}`)) as {
    tree?: GitHubTreeItem[]
  }
  return dropSubmodules(data.tree ?? [])
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

export async function searchCode(
  transport: GitHubTransport,
  owner: string,
  repo: string,
  query: string,
  pathFilter?: string,
): Promise<GitHubCodeSearchResult[]> {
  let q = `${query} repo:${owner}/${repo}`
  if (pathFilter !== undefined && pathFilter !== '') q += ` path:${pathFilter}`
  const data = (await transport.get(`/search/code`, { q })) as {
    items?: { path: string; sha: string }[]
  }
  return (data.items ?? []).map((it) => ({ path: it.path, sha: it.sha }))
}
