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

import { runWithSession } from '../context/session_context.ts'
import { FileStat, FileType, PathSpec } from '../types.ts'
import { Session } from '../workspace/session/session.ts'
import { enoent } from './errors.ts'
import {
  expandPattern,
  globPattern,
  globPrefix,
  globSpan,
  globStemPrefix,
  hasGlob,
  hasGlobPrefix,
  isWordShaped,
  literalWord,
  markEscapedGlobs,
  markGlobs,
  resolveGlobWith,
  spellMatch,
  unmarkGlobs,
} from './glob_walk.ts'
import { unescapeUnquoted } from '../shell/escapes.ts'
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
  '/box': ['/box/sub/', '/box/f.txt'],
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

describe('glob marks', () => {
  it('hides a quoted metacharacter from hasGlob and round-trips it', () => {
    const marked = markGlobs('a*b?c[d')
    expect(hasGlob(marked)).toBe(false)
    expect(unmarkGlobs(marked)).toBe('a*b?c[d')
    expect(marked.length).toBe('a*b?c[d'.length)
    expect(markGlobs('page.md')).toBe('page.md')
    expect(unmarkGlobs('page.md')).toBe('page.md')
  })

  it('marks one occurrence at a time', () => {
    // The word bash globs on the `?` alone: only the star is quoted.
    const word = markGlobs('*') + '?.txt'
    expect(hasGlob(word)).toBe(true)
    expect(unmarkGlobs(word)).toBe('*?.txt')
    expect(globPattern(word)).toBe('[*]?.txt')
  })

  it('hands a marked character to fnmatch as its own class', () => {
    expect(globPattern(markGlobs('*'))).toBe('[*]')
    expect(globPattern(markGlobs('?'))).toBe('[?]')
    expect(globPattern(markGlobs('['))).toBe('[[]')
    // A live glob character is left alone, so the two mix in one segment.
    expect(globPattern('*' + markGlobs('?'))).toBe('*[?]')
    expect(globPattern('plain.txt')).toBe('plain.txt')
  })

  it('reads backslashes the way bash does', () => {
    const marked = (text: string) => hasGlob(unescapeUnquoted(markEscapedGlobs(text)))
    expect(marked('Demo_*')).toBe(true)
    expect(marked('x?')).toBe(true)
    expect(marked('[ab]')).toBe(true)
    expect(marked('page.md')).toBe(false)
    expect(marked('\\*.txt')).toBe(false)
    expect(marked('a\\?b')).toBe(false)
    expect(marked('\\[ab]')).toBe(false)
    expect(marked('a\\*b*c')).toBe(true)
    // An escaped backslash does not quote what follows it.
    expect(marked('\\\\*')).toBe(true)
    expect(marked('\\\\\\*')).toBe(false)
    // A trailing backslash quotes nothing.
    expect(marked('a\\')).toBe(false)
  })
})

describe('literalWord', () => {
  it('freezes a pattern that carried marks', () => {
    const spec = new PathSpec({
      virtual: '/data/' + markGlobs('*') + '?.txt',
      directory: '/data/',
      resourcePath: markGlobs('*') + '?.txt',
      pattern: markGlobs('*') + '?.txt',
      resolved: false,
    })
    const out = literalWord(spec)
    expect(out).toBeInstanceOf(PathSpec)
    // The word after quote removal, and no pattern left to glob again.
    expect((out as PathSpec).virtual).toBe('/data/*?.txt')
    expect((out as PathSpec).pattern).toBeNull()
    expect((out as PathSpec).resolved).toBe(true)
  })

  it('leaves an unmarked spec untouched', () => {
    const spec = new PathSpec({
      virtual: '/data/*.txt',
      directory: '/data/',
      resourcePath: '*.txt',
      pattern: '*.txt',
      resolved: false,
    })
    expect(literalWord(spec)).toBe(spec)
    expect(literalWord('plain')).toBe('plain')
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

  // box, gdrive and dropbox mark a folder with a trailing slash on a cold
  // listing; the marker is not part of the name a match spells.
  it("drops a cold listing's directory marker from a match", async () => {
    const spec = globSpec('/box/*', '/box')
    const matched = await expandPattern(fakeReaddir, null, spec)
    expect(matched.map((m) => m.virtual)).toEqual(['/box/f.txt', '/box/sub'])
    expect(matched.map((m) => m.resourcePath)).toEqual(['f.txt', 'sub'])
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

describe('resolveGlobWith under hidden paths', () => {
  it('drops hidden matches', async () => {
    const sess = new Session({ sessionId: 'narrowed' })
    sess.hiddenPaths = { patterns: ['*.json'] }
    const result = await runWithSession(sess, () =>
      resolveGlobWith(
        fakeReaddir,
        null,
        [globSpec('/notion/pages/Demo_page__uuid1/page.*', '/notion')],
        undefined,
      ),
    )
    expect(result.map((r) => r.virtual)).toEqual(['/notion/pages/Demo_page__uuid1/page.md'])
  })

  it('an all-hidden match set falls back to the literal', async () => {
    const sess = new Session({ sessionId: 'narrowed' })
    sess.hiddenPaths = { patterns: ['*.json'] }
    const result = await runWithSession(sess, () =>
      resolveGlobWith(
        fakeReaddir,
        null,
        [globSpec('/notion/pages/Roadmap__uuid2/page.*', '/notion')],
        undefined,
      ),
    )
    expect(result).toHaveLength(1)
    expect(result[0]?.resolved).toBe(true)
    expect(result[0]?.pattern).toBeNull()
    expect(result[0]?.virtual).toBe('/notion/pages/Roadmap__uuid2/page.*')
  })
})

describe('globSpan', () => {
  it.each([
    ['2026-*', ['2026-01-01', '2027-01-01']],
    ['2026-01-*', ['2026-01-01', '2026-02-01']],
    ['2026-12-*', ['2026-12-01', '2027-01-01']],
    ['2026-01-05*', ['2026-01-05', '2026-01-06']],
    ['2026-01-05_*', ['2026-01-05', '2026-01-06']],
    ['2026-01-?', ['2026-01-01', '2026-02-01']],
  ])('reads the literal date prefix of %s', (pattern, expected) => {
    expect(globSpan(pattern)).toEqual(expected)
  })

  it.each([
    // No metacharacter at all is a literal name, not a span.
    ['2026-01-05'],
    ['chat*'],
    ['2026-13-*'],
    ['2026-02-30*'],
    [''],
    [null],
    [undefined],
  ])('has no span for %s', (pattern) => {
    expect(globSpan(pattern)).toBeNull()
  })
})

describe('globPrefix', () => {
  it.each([
    ['doc-1*', 'doc-1'],
    ['doc-1?.md', 'doc-1'],
    ['doc-1[0-9]', 'doc-1'],
    // A metacharacter first leaves nothing to narrow on, and a word with none
    // at all is a literal name rather than a glob.
    ['*.md', ''],
    ['?abc*', ''],
    ['doc-10.md', ''],
    ['', ''],
  ])('reads the literal head of %s', (pattern, expected) => {
    expect(globPrefix(pattern)).toBe(expected)
    expect(hasGlobPrefix(pattern)).toBe(expected !== '')
  })

  it('has no prefix for a missing pattern', () => {
    expect(globPrefix(null)).toBe('')
    expect(globPrefix(undefined)).toBe('')
  })

  it('restores a quoted metacharacter', () => {
    // A quoted star travels under a private mark and stands for a literal
    // star, so it belongs in the prefix as the character it names.
    expect(globPrefix(markGlobs('*') + 'ab*')).toBe('*ab')
  })
})

describe('globStemPrefix', () => {
  it.each([
    // The literal has run into the suffix, so the part that ran in says
    // nothing about the stem and comes off.
    ['12*.md', '12'],
    ['doc-1.m*', 'doc-1'],
    ['doc-1.*', 'doc-1'],
    ['doc-1.p*', 'doc-1'],
    // A dot inside the stem is not the suffix, so it stays.
    ['acct.2026*', 'acct.2026'],
    ['acct.mark*', 'acct.mark'],
    ['doc-1*', 'doc-1'],
    ['*.md', ''],
  ])('drops only a reached suffix from %s', (pattern, expected) => {
    expect(globStemPrefix(pattern, ['.md', '.png'])).toBe(expected)
  })

  it('has no prefix for a missing pattern', () => {
    expect(globStemPrefix(null, ['.md'])).toBe('')
  })
})

function fakeStat(_accessor: null, path: PathSpec): Promise<FileStat> {
  const key = rstripSlash(path.virtual) || '/'
  const name = key.slice(key.lastIndexOf('/') + 1)
  if (key in TREE) return Promise.resolve(new FileStat({ name, type: FileType.DIRECTORY }))
  const parent = key.slice(0, key.lastIndexOf('/')) || '/'
  if ((TREE[parent] ?? []).includes(key)) {
    return Promise.resolve(new FileStat({ name, type: FileType.FILE }))
  }
  return Promise.reject(enoent(path))
}

function typedSpec(virtual: string, raw: string): PathSpec {
  const base = globSpec(virtual, '')
  return new PathSpec({
    virtual: base.virtual,
    directory: base.directory,
    resourcePath: base.resourcePath,
    pattern: base.pattern,
    resolved: base.resolved,
    rawPath: raw,
  })
}

// The command tier's own resolver honours a trailing slash the way the
// shell tier does (#1065): directories only, and one slash kept.
describe('resolveGlobWith trailing slash', () => {
  it('keeps directories only and the slash', async () => {
    const out = await resolveGlobWith(
      fakeReaddir,
      null,
      [typedSpec('/*', '*/')],
      undefined,
      undefined,
      undefined,
      fakeStat,
    )
    expect(out.map((m) => [m.virtual, m.rawPath])).toEqual([['/alpha', 'alpha/']])
  })

  it('spells an absolute word', async () => {
    const out = await resolveGlobWith(
      fakeReaddir,
      null,
      [typedSpec('/notion/p*', '/notion/p*/')],
      undefined,
      undefined,
      undefined,
      fakeStat,
    )
    expect(out.map((m) => m.rawPath)).toEqual(['/notion/pages/'])
  })

  // The namespace's own answer for the names it owes: a link to a
  // directory, a nested mount root, a link to a file, a link to nothing.
  function fakeTargetStat(virtual: string): Promise<FileStat | null> {
    const name = virtual.slice(virtual.lastIndexOf('/') + 1)
    if (virtual === '/lnk' || virtual === '/inner') {
      return Promise.resolve(new FileStat({ name, type: FileType.DIRECTORY }))
    }
    if (virtual === '/flink') return Promise.resolve(new FileStat({ name, type: FileType.FILE }))
    return Promise.resolve(null)
  }
  const owed = (parent: string): string[] =>
    parent === '/' ? ['broken', 'flink', 'inner', 'lnk'] : []

  it('asks the namespace about an owed name', async () => {
    // bash follows a link for `*/` and keeps it only when the target is
    // a directory; a dangling one is dropped like any file.
    const out = await resolveGlobWith(
      fakeReaddir,
      null,
      [typedSpec('/*', '*/')],
      undefined,
      undefined,
      owed,
      fakeStat,
      fakeTargetStat,
    )
    expect(out.map((m) => m.rawPath)).toEqual(['alpha/', 'inner/', 'lnk/'])
  })

  it('keeps an owed name it cannot ask about', async () => {
    const out = await resolveGlobWith(
      fakeReaddir,
      null,
      [typedSpec('/*', '*/')],
      undefined,
      undefined,
      owed,
      fakeStat,
    )
    expect(out.map((m) => m.rawPath)).toEqual(['alpha/', 'broken/', 'flink/', 'inner/', 'lnk/'])
  })

  it('keeps every match without a stat door', async () => {
    const out = await resolveGlobWith(fakeReaddir, null, [typedSpec('/*', '*/')], undefined)
    expect(out.map((m) => m.rawPath)).toEqual(['alpha/', 'beta.txt/'])
  })

  it('keeps the typed word on zero matches', async () => {
    const out = await resolveGlobWith(
      fakeReaddir,
      null,
      [typedSpec('/zz*', 'zz*/')],
      undefined,
      undefined,
      undefined,
      fakeStat,
    )
    expect(out.map((m) => [m.rawPath, m.pattern])).toEqual([['zz*/', null]])
  })
})
