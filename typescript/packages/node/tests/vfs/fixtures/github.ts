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
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'

function sha1(text: string | Uint8Array): string {
  return createHash('sha1').update(text).digest('hex')
}

export function blobSha(data: Uint8Array): string {
  return sha1(Buffer.concat([Buffer.from(`blob ${String(data.byteLength)}\0`), data]))
}

/**
 * A github repository behind a fetch router, for node suites that need the
 * wire. Inlined because core's FakeGitHub (_test_util.ts) is left out of
 * core's build. A tree asked by ref answers the head commit as its top-level
 * `sha`, as GitHub does, derived from the files at request time; a folder's
 * `{ref}:{dir}` listing answers that folder's own sha, which differs.
 */
export class InlineGitHub {
  readonly files = new Map<string, Uint8Array>()
  readonly log: string[] = []
  readonly url = 'http://github.test'

  constructor(files: Record<string, string> = {}) {
    for (const [path, data] of Object.entries(files)) this.set(path, data)
  }

  set(path: string, data: string): void {
    this.files.set(path, Buffer.from(data))
  }

  count(route: string): number {
    return this.log.filter((name) => name === route).length
  }

  head(): string {
    const rows = [...this.files]
      .map(([path, data]) => `${path}\0${blobSha(data)}`)
      .sort(compareCodePoints)
    return sha1(`commit ${rows.join('\n')}`)
  }

  private dirs(): Set<string> {
    const out = new Set<string>()
    for (const path of this.files.keys()) {
      const parts = path.split('/').slice(0, -1)
      for (let i = 1; i <= parts.length; i += 1) out.add(parts.slice(0, i).join('/'))
    }
    return out
  }

  private treeSha(at: string): string {
    const prefix = at === '' ? '' : `${at}/`
    const rows = [...this.files]
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, data]) => `${path}\0${blobSha(data)}`)
      .sort(compareCodePoints)
    return sha1(`tree ${at}\n${rows.join('\n')}`)
  }

  private row(path: string, name: string): Record<string, unknown> {
    const data = this.files.get(path)
    if (data === undefined) return { path: name, type: 'tree', sha: this.treeSha(path) }
    return { path: name, type: 'blob', sha: blobSha(data), size: data.byteLength }
  }

  private shallow(at: string): Record<string, unknown>[] {
    const prefix = at === '' ? '' : `${at}/`
    const names = new Set<string>()
    for (const p of [...this.files.keys(), ...this.dirs()]) {
      if (p.startsWith(prefix) && p !== at) names.add(p.slice(prefix.length).split('/')[0] ?? '')
    }
    return [...names].sort(compareCodePoints).map((n) => this.row(prefix + n, n))
  }

  readonly fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(new Request(input, init).url)
    const reply = (body: unknown, status = 200): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      )
    const tree = /\/git\/trees\/([^/]+)$/.exec(url.pathname)
    if (tree !== null) {
      const segment = decodeURIComponent(tree[1] ?? '')
      if (url.searchParams.get('recursive') === '1') {
        this.log.push('recursive')
        const paths = [...this.files.keys(), ...this.dirs()].sort(compareCodePoints)
        return reply({
          sha: this.head(),
          tree: paths.map((p) => this.row(p, p)),
          truncated: false,
        })
      }
      this.log.push('dir')
      const colon = segment.indexOf(':')
      const at = colon < 0 ? '' : segment.slice(colon + 1).replace(/^\/+|\/+$/g, '')
      if (at !== '' && !this.dirs().has(at)) return reply({ message: 'Not Found' }, 404)
      return reply({
        sha: colon < 0 ? this.head() : this.treeSha(at),
        tree: this.shallow(at),
        truncated: false,
      })
    }
    const blob = /\/git\/blobs\/([^/]+)$/.exec(url.pathname)
    if (blob !== null) {
      this.log.push('blob')
      const data = [...this.files.values()].find((d) => blobSha(d) === blob[1])
      if (data === undefined) return reply({ message: 'Not Found' }, 404)
      if ((new Request(input, init).headers.get('accept') ?? '').includes('raw'))
        return Promise.resolve(new Response(Buffer.from(data)))
      return reply({ content: Buffer.from(data).toString('base64'), encoding: 'base64' })
    }
    if (/^\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) return reply({ default_branch: 'main' })
    throw new Error(`InlineGitHub: unrouted ${url.pathname}`)
  }
}
