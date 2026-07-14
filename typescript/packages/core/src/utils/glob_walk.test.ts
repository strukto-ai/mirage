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

import { beforeEach, describe, expect, it } from 'vitest'

import { PathSpec } from '../types.ts'
import { enoent } from './errors.ts'
import { expandPattern, hasGlob, isWordShaped, resolveGlobWith, spellMatch } from './glob_walk.ts'
import { rstripSlash, stripSlash } from './slash.ts'

const TREE: Record<string, string[]> = {
  '/notion': ['/notion/pages', '/notion/databases'],
  '/notion/pages': ['/notion/pages/Demo_page__uuid1', '/notion/pages/Roadmap__uuid2'],
  '/notion/pages/Demo_page__uuid1': [
    '/notion/pages/Demo_page__uuid1/page.md',
    '/notion/pages/Demo_page__uuid1/page.json',
  ],
  '/notion/pages/Roadmap__uuid2': ['/notion/pages/Roadmap__uuid2/page.json'],
  '/': ['/alpha', '/beta.txt'],
  '/alpha': ['/alpha/b.txt'],
}

let calls: string[] = []

function fakeReaddir(_accessor: null, path: PathSpec): Promise<string[]> {
  calls.push(path.virtual)
  const key = rstripSlash(path.virtual) || '/'
  const entries = TREE[key]
  if (entries === undefined) return Promise.reject(enoent(path))
  return Promise.resolve(entries)
}

function globSpec(virtual: string, prefix: string): PathSpec {
  const lastSlash = virtual.lastIndexOf('/')
  return new PathSpec({
    virtual,
    directory: virtual.slice(0, lastSlash + 1),
    resourcePath: stripSlash(virtual.slice(prefix.length)),
    pattern: virtual.slice(lastSlash + 1),
    resolved: false,
  })
}

beforeEach(() => {
  calls = []
})

describe('hasGlob', () => {
  it('detects glob characters', () => {
    expect(hasGlob('Demo_*')).toBe(true)
    expect(hasGlob('x?')).toBe(true)
    expect(hasGlob('[ab]')).toBe(true)
    expect(hasGlob('page.md')).toBe(false)
  })
})

describe('expandPattern', () => {
  it('expands a mid-path glob without listing the pattern dir', async () => {
    const spec = globSpec('/notion/pages/Demo_page__*/page.md', '/notion')
    const matched = await expandPattern(fakeReaddir, null, spec)
    expect(matched.map((m) => m.virtual)).toEqual(['/notion/pages/Demo_page__uuid1/page.md'])
    expect(matched[0]?.resourcePath).toBe('pages/Demo_page__uuid1/page.md')
    expect(calls.every((c) => !c.includes('*'))).toBe(true)
  })

  it('expands a last-component glob', async () => {
    const spec = globSpec('/notion/pages/Demo*', '/notion')
    const matched = await expandPattern(fakeReaddir, null, spec)
    expect(matched.map((m) => m.virtual)).toEqual(['/notion/pages/Demo_page__uuid1'])
    expect(matched[0]?.resolved).toBe(true)
  })

  it('expands multiple glob segments', async () => {
    const spec = globSpec('/notion/pages/*__uuid*/page.json', '/notion')
    const matched = await expandPattern(fakeReaddir, null, spec)
    expect(matched.map((m) => m.virtual)).toEqual([
      '/notion/pages/Demo_page__uuid1/page.json',
      '/notion/pages/Roadmap__uuid2/page.json',
    ])
  })

  it('returns empty on zero matches', async () => {
    const spec = globSpec('/notion/pages/Missing__*/page.md', '/notion')
    expect(await expandPattern(fakeReaddir, null, spec)).toEqual([])
  })

  it('skips non-directory intermediates', async () => {
    const spec = globSpec('/*/b.txt', '')
    const matched = await expandPattern(fakeReaddir, null, spec)
    expect(matched.map((m) => m.virtual)).toEqual(['/alpha/b.txt'])
  })

  it('expands a glob at a root mount', async () => {
    const spec = globSpec('/a*', '')
    const matched = await expandPattern(fakeReaddir, null, spec)
    expect(matched.map((m) => m.virtual)).toEqual(['/alpha'])
    expect(matched[0]?.resourcePath).toBe('alpha')
  })
})

describe('spellMatch', () => {
  it('spells a relative mid-path match', () => {
    expect(spellMatch('s*/x.txt', '/data/sub/x.txt', 2)).toBe('sub/x.txt')
  })

  it('keeps the typed head', () => {
    expect(spellMatch('./sub/*.txt', '/data/sub/a.txt', 1)).toBe('./sub/a.txt')
    expect(spellMatch('../s*/x.txt', '/data/sub/x.txt', 2)).toBe('../sub/x.txt')
  })

  it('bare and absolute words', () => {
    expect(spellMatch('*.txt', '/data/a.txt', 1)).toBe('a.txt')
    expect(spellMatch('/data/s*/x.txt', '/data/sub/x.txt', 2)).toBe('/data/sub/x.txt')
  })
})

describe('isWordShaped', () => {
  it('distinguishes typed words from dir-shaped specs', () => {
    const word = globSpec('/notion/pages/*.md', '/notion')
    expect(isWordShaped(word)).toBe(true)
    expect(isWordShaped(word.dir)).toBe(false)
  })
})

describe('resolveGlobWith', () => {
  it('spells matches from the typed word', async () => {
    const spec = globSpec('/notion/pages/Demo_page__*/page.md', '/notion')
    const typed = new PathSpec({
      virtual: spec.virtual,
      directory: spec.directory,
      resourcePath: spec.resourcePath,
      pattern: spec.pattern,
      resolved: false,
      rawPath: 'pages/Demo_page__*/page.md',
    })
    const out = await resolveGlobWith(fakeReaddir, null, [typed], undefined)
    expect(out.map((m) => m.rawPath)).toEqual(['pages/Demo_page__uuid1/page.md'])
  })

  it('keeps the literal word on zero match', async () => {
    const spec = globSpec('/notion/pages/*.nope', '/notion')
    const out = await resolveGlobWith(fakeReaddir, null, [spec], undefined)
    expect(out).toHaveLength(1)
    expect(out[0]?.virtual).toBe('/notion/pages/*.nope')
    expect(out[0]?.pattern).toBeNull()
    expect(out[0]?.resolved).toBe(true)
  })

  it('dir-shaped zero match stays empty', async () => {
    const spec = globSpec('/notion/pages/*.nope', '/notion').dir
    const out = await resolveGlobWith(fakeReaddir, null, [spec], undefined)
    expect(out).toEqual([])
  })
})
