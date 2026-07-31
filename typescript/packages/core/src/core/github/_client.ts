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

export const GITHUB_API_BASE = 'https://api.github.com'
export const GITHUB_API_VERSION = '2022-11-28'

export interface GitHubTransport {
  get(path: string, params?: Record<string, string>): Promise<unknown>
}

export class HttpGitHubTransport implements GitHubTransport {
  readonly token: string
  readonly baseUrl: string

  constructor(opts: { token: string; baseUrl?: string }) {
    this.token = opts.token
    this.baseUrl = opts.baseUrl ?? GITHUB_API_BASE
  }

  async get(path: string, params?: Record<string, string>): Promise<unknown> {
    const url = new URL(this.baseUrl + path)
    if (params !== undefined) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    }
    const r = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      },
    })
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      throw new GitHubApiError(`GitHub ${path} → ${String(r.status)} ${body}`, r.status)
    }
    return r.json()
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
