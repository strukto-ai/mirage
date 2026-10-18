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

import { describe, expect, it } from 'vitest'
import { InlineGitHub } from './github.ts'

const HEX40 = /^[0-9a-f]{40}$/

interface Row {
  path: string
  type: string
  sha: string
}

interface Tree {
  sha: string
  tree: Row[]
}

async function get(gh: InlineGitHub, segment: string, recursive = false): Promise<[number, Tree]> {
  const query = recursive ? '?recursive=1' : ''
  const url = `${gh.url}/repos/o/r/git/trees/${encodeURIComponent(segment)}${query}`
  const response = await gh.fetch(url)
  return [response.status, (await response.json()) as Tree]
}

async function sha(gh: InlineGitHub, segment: string, recursive = false): Promise<string> {
  const [status, body] = await get(gh, segment, recursive)
  expect(status, segment).toBe(200)
  return body.sha
}

function repo(): InlineGitHub {
  return new InlineGitHub({ 'docs/a.txt': 'alpha', 'docs/sub/b.txt': 'bravo', 'top.txt': 'top' })
}

describe('InlineGitHub', () => {
  it('moves the head on an add, an edit and a delete, and back on a revert', async () => {
    const gh = repo()
    const first = await sha(gh, 'main')
    expect(first).toMatch(HEX40)
    expect(gh.head()).toBe(first)
    expect(await sha(gh, 'main', true)).toBe(first)
    gh.set('new.txt', 'new')
    const added = await sha(gh, 'main', true)
    expect(added).not.toBe(first)
    gh.set('docs/a.txt', 'alpha, edited')
    const edited = await sha(gh, 'main')
    expect(new Set([first, added, edited]).size).toBe(3)
    gh.files.delete('new.txt')
    const deleted = gh.head()
    expect(new Set([first, added, edited, deleted]).size).toBe(4)
    gh.set('docs/a.txt', 'alpha')
    expect(await sha(gh, 'main')).toBe(first)
  })

  it('answers a ref and its root tree with different shas', async () => {
    const gh = repo()
    const head = await sha(gh, 'main')
    const root = await sha(gh, 'main:')
    expect(root).toMatch(HEX40)
    expect(root).not.toBe(head)
    const [, top] = await get(gh, 'main')
    const [, rooted] = await get(gh, 'main:')
    expect(rooted.tree).toEqual(top.tree)
  })

  it('moves a folder sha only when something under it changes', async () => {
    const gh = repo()
    const docs = await sha(gh, 'main:docs')
    gh.set('top.txt', 'top, edited')
    expect(await sha(gh, 'main:docs')).toBe(docs)
    gh.set('docs/sub/b.txt', 'bravo, edited')
    expect(await sha(gh, 'main:docs')).not.toBe(docs)
    const [status] = await get(gh, 'main:missing')
    expect(status).toBe(404)
  })

  it('serves every blob sha its recursive tree lists', async () => {
    const gh = repo()
    const [, body] = await get(gh, 'main', true)
    const blobs = body.tree.filter((row) => row.type === 'blob')
    expect(blobs.map((row) => row.path)).toEqual(['docs/a.txt', 'docs/sub/b.txt', 'top.txt'])
    for (const row of blobs) {
      const response = await gh.fetch(`${gh.url}/repos/o/r/git/blobs/${row.sha}`)
      expect(response.status, row.path).toBe(200)
      const { content } = (await response.json()) as { content: string }
      expect(Buffer.from(content, 'base64').toString()).toBe(
        Buffer.from(gh.files.get(row.path) ?? new Uint8Array()).toString(),
      )
    }
    expect(gh.count('recursive')).toBe(1)
    expect(gh.count('blob')).toBe(3)
  })
})
