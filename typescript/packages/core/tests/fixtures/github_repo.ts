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

import { createHash } from 'node:crypto'
import { KitRun, type JsonValue } from './kit_fake.ts'

export const TOKEN = 'unit'
export const OWNER = 'integ-user'
export const REPO_ROUTE = '/repos/:owner/:repo'
export const TREES = '/repos/:owner/:repo/git/trees/*ref'
export const BLOBS = '/repos/:owner/:repo/git/blobs/:sha'
export const SEARCH = '/search/code'
export const GRAPHQL = '/graphql'
export const RAW = '/raw/:owner/:repo/:ref/*path'
export const UNTIL_CLEARED = 1_000_000

const ENC = new TextEncoder()
const SHA40 = /^[0-9a-fA-F]{40}$/

// What `refuse` and `answer` name a request by: its method, its route, and
// the query string it is asked with, null for any.
const NAMED: Record<string, [string, string, string | null]> = {
  dir: ['GET', TREES, ''],
  recursive: ['GET', TREES, 'recursive=1'],
  blob: ['GET', BLOBS, null],
  repo: ['GET', REPO_ROUTE, null],
  search: ['GET', SEARCH, null],
}

type Bytes = string | Uint8Array

function bytesOf(data: Bytes): Uint8Array {
  return typeof data === 'string' ? ENC.encode(data) : data
}

/** The git blob sha of `data`, as GitHub names a file's bytes. */
export function blobSha(data: Bytes): string {
  const bytes = bytesOf(data)
  return createHash('sha1')
    .update(`blob ${String(bytes.length)}\0`)
    .update(bytes)
    .digest('hex')
}

/** A tree GitHub answers, as far as these tests read one. */
export interface TreeAnswer {
  [key: string]: JsonValue
  sha: string
  tree: { path: string; type: string; sha: string; mode: string; size?: number }[]
  truncated: boolean
}

interface Listed {
  method: string
  route: string
  path: string
  query: string
  body: JsonValue
}

/**
 * One repository on the GitHub fake, and the commits a test arranges it by.
 *
 * Every change is a commit on `main` made through the git database API,
 * blobs then a tree then the commit, with the branch moved onto it, so the
 * head moves the way a push moves it and every earlier commit, tree and blob
 * stays readable by its sha, as on GitHub. It needs nothing of core's own
 * code, so node's suites, which test core's build, use it as it is.
 */
export class GitHubRepo {
  readonly run: KitRun
  readonly owner = OWNER
  readonly api: string

  /** @param origin the GitHub fake's origin. */
  constructor(
    origin: string,
    readonly name = 'repo',
  ) {
    this.run = new KitRun(origin, { Authorization: `Bearer ${TOKEN}` })
    this.api = `/repos/${OWNER}/${name}`
  }

  /** A mount config for this repository with a token, plus `fields`. */
  config(fields: Record<string, JsonValue> = {}): Record<string, JsonValue> {
    return { token: TOKEN, owner: this.owner, repo: this.name, base_url: this.run.url, ...fields }
  }

  /**
   * Create the repository holding exactly `files` on `main`, start recording
   * the requests made to it, and answer its head.
   */
  async create(files: Record<string, Bytes>, isPrivate = false): Promise<string> {
    await this.run.call('POST', '/user/repos', {
      json: { name: this.name, auto_init: true, private: isPrivate },
    })
    const head = await this.replace(files)
    await this.run.recordRequests()
    return head
  }

  /** What GitHub answers for the tree `segment` names, unquoted. */
  async tree(segment: string, recursive = false): Promise<TreeAnswer> {
    const query = recursive ? '?recursive=1' : ''
    return this.run.call<TreeAnswer>(
      'GET',
      `${this.api}/git/trees/${encodeURIComponent(segment)}${query}`,
    )
  }

  /** The commit `branch` points at. */
  async head(branch = 'main'): Promise<string> {
    return (await this.tree(branch)).sha
  }

  /**
   * Every path `main` holds that is no folder: its files and its submodule
   * gitlinks. A truncated tree names only the top level, so it is walked
   * folder by folder instead.
   */
  async paths(): Promise<string[]> {
    const tree = await this.tree('main', true)
    if (!tree.truncated) {
      return tree.tree.filter((row) => row.type !== 'tree').map((row) => row.path)
    }
    const found: string[] = []
    const folders = ['']
    for (let at = folders.pop(); at !== undefined; at = folders.pop()) {
      for (const row of (await this.tree(`main:${at}`)).tree) {
        const path = at === '' ? row.path : `${at}/${row.path}`
        ;(row.type === 'tree' ? folders : found).push(path)
      }
    }
    return found
  }

  /** Commit `changes` onto `branch`, null deleting a path, and answer the new head. */
  async commit(changes: Record<string, Bytes | null>, branch = 'main'): Promise<string> {
    const entries: JsonValue[] = []
    for (const [path, data] of Object.entries(changes)) {
      let sha: string | null = null
      if (data !== null) {
        const blob = await this.run.call<{ sha: string }>('POST', `${this.api}/git/blobs`, {
          json: { content: Buffer.from(bytesOf(data)).toString('base64'), encoding: 'base64' },
        })
        sha = blob.sha
      }
      entries.push({ path, mode: '100644', type: 'blob', sha })
    }
    return this.commitEntries(entries, branch)
  }

  /** Commit a submodule gitlink at `path` pinning `commit` onto `main`; answer the new head. */
  async link(path: string, commit: string): Promise<string> {
    return this.commitEntries([{ path, mode: '160000', type: 'commit', sha: commit }])
  }

  /** Start branch `name` at the commit `main` points at. */
  async branch(name: string): Promise<void> {
    await this.run.call('POST', `${this.api}/git/refs`, {
      json: { ref: `refs/heads/${name}`, sha: await this.head() },
    })
  }

  /** Make branch `name` the repository's default. */
  async setDefaultBranch(name: string): Promise<void> {
    await this.run.call('PATCH', this.api, { json: { default_branch: name } })
  }

  private async commitEntries(entries: JsonValue[], branch = 'main'): Promise<string> {
    const head = await this.head(branch)
    const tree = await this.run.call<{ sha: string }>('POST', `${this.api}/git/trees`, {
      json: { tree: entries, base_tree: head },
    })
    const made = await this.run.call<{ sha: string }>('POST', `${this.api}/git/commits`, {
      json: { message: 'change', tree: tree.sha, parents: [head] },
    })
    await this.run.call('PATCH', `${this.api}/git/refs/heads/${branch}`, {
      json: { sha: made.sha },
    })
    return made.sha
  }

  /** Commit `main` to hold exactly `files` and answer the new head. */
  async replace(files: Record<string, Bytes>): Promise<string> {
    const gone: Record<string, Bytes | null> = {}
    for (const path of await this.paths()) if (!(path in files)) gone[path] = null
    return this.commit({ ...gone, ...files })
  }

  /**
   * Answer the recursive tree truncated from now on, top-level rows only,
   * as git cuts a tree past its entry cap. The run is reloaded, so the
   * request list starts afresh.
   */
  async truncate(): Promise<void> {
    await this.run.execute(
      'UPDATE GithubRepo SET truncated = 1 WHERE fullName = ?',
      `${this.owner}/${this.name}`,
    )
    await this.run.recordRequests()
  }

  /**
   * Answer the shallow listing of `folder`, asked by its sha or as
   * `main:{folder}`, cut to its first `keep` rows and marked truncated,
   * until cleared. GitHub cuts a listing past its entry cap; no directory the
   * fake holds is that large, so its own answer is changed in that one way.
   */
  async cutShort(folder: string, keep: number): Promise<void> {
    const listing = await this.tree(`main:${folder}`)
    const cut = { ...listing, tree: listing.tree.slice(0, keep), truncated: true }
    for (const segment of [listing.sha, `main:${folder}`]) {
      await this.run.answerNext('GET', TREES, 200, cut, UNTIL_CLEARED, this.treePath(segment), '')
    }
  }

  /** The path a tree request for `segment` arrives at, as Mirage's client sends it. */
  treePath(segment: string): string {
    return `${this.api}/git/trees/${encodeURIComponent(segment)}`
  }

  /** The query string a code search for `q` arrives with: `q`, then the largest page. */
  searchQuery(q: string): string {
    return new URLSearchParams({ q, per_page: '100' }).toString()
  }

  /** Answer the requests `log` names `name` with `status`, every one until cleared by default. */
  async refuse(
    name: string,
    status: number,
    message: string,
    times = UNTIL_CLEARED,
  ): Promise<void> {
    const [method, route, query] = NAMED[name] ?? []
    if (method === undefined || route === undefined) throw new Error(`no request named ${name}`)
    await this.run.answerNext(
      method,
      route,
      status,
      { message },
      times,
      undefined,
      query ?? undefined,
    )
  }

  /** Answer the next `times` requests `log` names `name` with a 200 carrying `body`. */
  async answer(name: string, body: JsonValue, times = 1): Promise<void> {
    const [method, route, query] = NAMED[name] ?? []
    if (method === undefined || route === undefined) throw new Error(`no request named ${name}`)
    await this.run.answerNext(method, route, 200, body, times, undefined, query ?? undefined)
  }

  private async isCommit(sha: string): Promise<boolean> {
    const res = await this.run.request('GET', `${this.api}/git/commits/${sha}`)
    await res.text()
    return res.status === 200
  }

  /**
   * Each request made since recording started, as `[name, segment]`. A tree
   * is `recursive`, `dir` for a ref, a commit or `{rev}:{dir}`, and
   * `sha_dir` for a tree by its own sha, each with its segment as sent. A
   * blob is `blob` with its sha, a raw download `raw` with `{commit}/{path}`,
   * code search `search` with its `q`, GraphQL `graphql` with the oids it
   * asked joined by commas, and the repository `repo`; any other request is
   * named by its method and route.
   */
  async log(): Promise<[string, string][]> {
    const listed = await this.run.call<{ requests: Listed[] }>('GET', '/_kit/requests')
    const named: [string, string][] = []
    for (const r of listed.requests) {
      const params = new URLSearchParams(r.query)
      if (r.route === TREES) {
        const segment = r.path.slice(r.path.indexOf('/git/trees/') + '/git/trees/'.length)
        let name = 'dir'
        if (params.has('recursive')) name = 'recursive'
        else if (!decodeURIComponent(segment).includes(':') && SHA40.test(segment)) {
          name = (await this.isCommit(segment)) ? 'dir' : 'sha_dir'
        }
        named.push([name, segment])
      } else if (r.route === BLOBS) {
        named.push(['blob', r.path.slice(r.path.lastIndexOf('/') + 1)])
      } else if (r.route === RAW) {
        const prefix = `/raw/${this.owner}/${this.name}/`
        named.push(['raw', decodeURIComponent(r.path.slice(prefix.length))])
      } else if (r.route === REPO_ROUTE) {
        named.push(['repo', ''])
      } else if (r.route === SEARCH) {
        named.push(['search', params.get('q') ?? ''])
      } else if (r.route === GRAPHQL) {
        const asked = (r.body as { variables?: Record<string, JsonValue> } | null)?.variables ?? {}
        const oids = Object.entries(asked)
          .filter(([k]) => k !== 'owner' && k !== 'repo')
          .map(([, v]) => (typeof v === 'string' ? v : JSON.stringify(v)))
        named.push(['graphql', oids.join(',')])
      } else {
        named.push([`${r.method} ${r.route}`, r.path])
      }
    }
    return named
  }

  /** How many requests `log` names `name`. */
  async count(name: string): Promise<number> {
    return (await this.log()).filter(([got]) => got === name).length
  }

  /** How many `dir`, `recursive` and `blob` requests were made. */
  async counts(): Promise<[number, number, number]> {
    const names = (await this.log()).map(([name]) => name)
    const n = (want: string): number => names.filter((name) => name === want).length
    return [n('dir'), n('recursive'), n('blob')]
  }
}
