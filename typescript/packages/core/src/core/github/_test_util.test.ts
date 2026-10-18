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
import { BASE, FakeGitHub } from '../../../tests/core/github/_test_util.ts'

const HEX40 = /^[0-9a-f]{40}$/

interface Tree {
  sha: string
  tree: { path: string; sha: string }[]
}

async function get(gh: FakeGitHub, segment: string): Promise<[number, Tree]> {
  const [raw, query] = segment.split('?')
  const url = `${BASE}/repos/o/r/git/trees/${encodeURIComponent(raw ?? '')}${query === undefined ? '' : `?${query}`}`
  const response = await gh.fetch(url)
  return [response.status, (await response.json()) as Tree]
}

async function sha(gh: FakeGitHub, segment: string): Promise<string> {
  const [status, body] = await get(gh, segment)
  expect(status, segment).toBe(200)
  return body.sha
}

async function rows(gh: FakeGitHub, segment: string): Promise<Map<string, string>> {
  const [status, body] = await get(gh, segment)
  expect(status, segment).toBe(200)
  return new Map(body.tree.map((row) => [row.path, row.sha]))
}

function hub(): FakeGitHub {
  return new FakeGitHub({
    'docs/a.txt': 'alpha',
    'docs/sub/b.txt': 'bravo',
    'src/c.txt': 'charlie',
    'top.txt': 'top',
  })
}

describe('FakeGitHub head commits', () => {
  it('answers a ref with its head commit, derived from the files now', async () => {
    const gh = hub()
    const first = await sha(gh, 'main')
    expect(first).toMatch(HEX40)
    expect(await sha(gh, 'main')).toBe(first)
    expect(await sha(gh, 'main?recursive=1')).toBe(first)
    gh.set('docs/a.txt', 'alpha, edited')
    const edited = await sha(gh, 'main')
    expect(edited).not.toBe(first)
    expect(await sha(gh, 'main?recursive=1')).toBe(edited)
    gh.set('docs/a.txt', 'alpha')
    expect(await sha(gh, 'main')).toBe(first)
  })

  it('counts the symlink bit in the head', async () => {
    const gh = hub()
    const plain = await sha(gh, 'main')
    gh.symlinks.add('top.txt')
    expect(await sha(gh, 'main')).not.toBe(plain)
  })

  it('answers a ref and its root tree with different shas', async () => {
    const gh = hub()
    const head = await sha(gh, 'main')
    const root = await sha(gh, 'main:')
    expect(root).toMatch(HEX40)
    expect(root).not.toBe(head)
  })
})

describe('FakeGitHub folder trees', () => {
  it('moves a folder sha only when something under it changes', async () => {
    const gh = hub()
    const before = await rows(gh, 'main')
    expect(before.get('docs')).toMatch(HEX40)
    expect(await sha(gh, 'main:docs')).toBe(before.get('docs'))
    const root = await sha(gh, 'main:')
    gh.set('docs/sub/b.txt', 'bravo, edited')
    const after = await rows(gh, 'main')
    expect(after.get('docs')).not.toBe(before.get('docs'))
    expect(after.get('src')).toBe(before.get('src'))
    expect(await sha(gh, 'main:')).not.toBe(root)
    expect(await sha(gh, 'main:docs')).toBe(after.get('docs'))
  })

  it('lists a folder by its sha, now and after the folder moved on', async () => {
    const gh = hub()
    const old = (await rows(gh, 'main')).get('docs') ?? ''
    expect([...(await rows(gh, old)).keys()].sort()).toEqual(['a.txt', 'sub'])
    gh.set('docs/new.txt', 'new')
    const now = (await rows(gh, 'main')).get('docs') ?? ''
    expect([...(await rows(gh, now)).keys()].sort()).toEqual(['a.txt', 'new.txt', 'sub'])
    expect([...(await rows(gh, old)).keys()].sort()).toEqual(['a.txt', 'sub'])
  })
})

describe('FakeGitHub history', () => {
  it('serves an old head as the files it named', async () => {
    const gh = hub()
    const old = await sha(gh, 'main')
    gh.set('docs/new.txt', 'new')
    gh.files.delete('top.txt')
    expect(await sha(gh, 'main')).not.toBe(old)
    expect([...(await rows(gh, old)).keys()].sort()).toEqual(['docs', 'src', 'top.txt'])
    const [status, body] = await get(gh, `${old}?recursive=1`)
    expect(status).toBe(200)
    expect(body.sha).toBe(old)
    expect(body.tree.map((row) => row.path)).not.toContain('docs/new.txt')
    expect([...(await rows(gh, `${old}:docs`)).keys()].sort()).toEqual(['a.txt', 'sub'])
    expect([...(await rows(gh, 'main:docs')).keys()].sort()).toEqual(['a.txt', 'new.txt', 'sub'])
  })

  it('does not find a sha it never answered', async () => {
    const gh = hub()
    await sha(gh, 'main')
    const unknown = '0'.repeat(40)
    expect((await get(gh, unknown))[0]).toBe(404)
    expect((await get(gh, `${unknown}?recursive=1`))[0]).toBe(404)
    expect((await get(gh, `${unknown}:docs`))[0]).toBe(404)
  })
})

describe('FakeGitHub hooks', () => {
  it('holds only the shallow listing of the ref on holdDir', async () => {
    const gh = hub()
    let release: () => void = () => undefined
    gh.holdDir = new Promise<void>((done) => {
      release = done
    })
    let answered: string | null = null
    const held = sha(gh, 'main').then((value) => {
      answered = value
    })
    for (let i = 0; i < 100 && !gh.log.some(([r, raw]) => r === 'dir' && raw === 'main'); i += 1)
      await new Promise((done) => setTimeout(done, 5))
    expect(gh.log).toContainEqual(['dir', 'main'])
    expect((await rows(gh, 'main:docs')).size).toBeGreaterThan(0)
    expect((await get(gh, 'main?recursive=1'))[0]).toBe(200)
    expect(answered).toBeNull()
    gh.set('new.txt', 'new')
    release()
    await held
    expect(answered).toBe(await gh.head())
  })
})
