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
import { UsageError } from '../errors.ts'
import {
  type DirRules,
  type IgnoreSources,
  IgnoreRules,
  IgnoreStack,
  Overrides,
  Verdict,
  compileGlob,
  ignoreLines,
  overrideGlob,
  walkCandidate,
} from './rg_glob.ts'

describe('compileGlob', () => {
  // globset with literal separators, which ripgrep builds -g with.
  it.each([
    ['*.py', 'a.py', true],
    ['*.py', 'sub/a.py', false],
    ['?.py', 'a.py', true],
    ['?.py', 'ab.py', false],
    ['**', 'a/b/c', true],
    ['**/c', 'c', true],
    ['**/c', 'a/b/c', true],
    ['a/**/c', 'a/c', true],
    ['a/**/c', 'a/x/y/c', true],
    ['a/**', 'a/b/c', true],
    ['a**', 'ab/c', false],
    ['[ab].*', 'b.py', true],
    ['[!ab].*', 'b.py', false],
    ['[^ab].*', 'c.py', true],
    ['[a-c]x', 'bx', true],
    ['[]]x', ']x', true],
    ['*.{py,md}', 'c.md', true],
    ['*.{py,md}', 'c.rs', false],
    ['\\*x', '*x', true],
    ['\\*x', 'ax', false],
  ])('keeps single stars inside a component: %s over %s', (glob, path, hit) => {
    expect(compileGlob(glob).test(path)).toBe(hit)
  })

  it('folds case on request', () => {
    expect(compileGlob('*.PY', true).test('a.py')).toBe(true)
    expect(compileGlob('*.PY').test('a.py')).toBe(false)
  })

  // ripgrep 14.1.1's --iglob folds A-Z and a-z, nothing past ASCII. Twin of
  // test_compile_glob_folds_ascii_letters_only.
  it.each([
    ['b3.txt', 'B3.TXT', true],
    ['[a-c]3.txt', 'B3.txt', true],
    ['[^a].txt', 'A.txt', false],
    ['sa.txt', '\u017fa.txt', false],
    ['k1.txt', '\u212a1.txt', false],
    ['\u00e92.txt', '\u00c92.txt', false],
  ])('folds %s against %s: %s', (glob, path, hit) => {
    expect(compileGlob(glob, true).test(path)).toBe(hit)
  })

  it.each([
    ['[', "unclosed character class; missing ']'"],
    ['a{b', "unclosed alternate group; missing '}' (maybe escape '{' with '[{]'?)"],
    ['a}b', "unopened alternate group; missing '{' (maybe escape '}' with '[}]'?)"],
    ['{a,{b}}', 'nested alternate groups are not allowed'],
    ['a\\', "dangling '\\'"],
  ])("refuses %s in globset's words", (glob, reason) => {
    let caught: unknown = null
    try {
      compileGlob(glob)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(UsageError)
    expect((caught as UsageError).message).toBe(`rg: error parsing glob '${glob}': ${reason}`)
    expect((caught as UsageError).exitCode).toBe(2)
  })

  it('names the glob as typed in a refusal', () => {
    // `-g '['` is compiled as `**/[` but refused as typed (ripgrep 14.1.1).
    expect(() => overrideGlob('[', false)).toThrow("'['")
  })
})

describe('overrideGlob', () => {
  it.each(['', '#comment', '   '])('reads %j as no glob', (line) => {
    expect(overrideGlob(line, false)).toBeNull()
  })

  it('matches an unslashed glob at any depth', () => {
    const glob = overrideGlob('*.py', false)
    expect(glob?.keep).toBe(true)
    expect(glob?.dirOnly).toBe(false)
    expect(glob?.matcher.test('a.py')).toBe(true)
    expect(glob?.matcher.test('sub/deep/a.py')).toBe(true)
  })

  it('anchors a slashed glob to the walk root', () => {
    const anchored = overrideGlob('/a.txt', false)
    expect(anchored?.matcher.test('a.txt')).toBe(true)
    expect(anchored?.matcher.test('sub/a.txt')).toBe(false)
    expect(overrideGlob('sub/*.txt', false)?.matcher.test('x/sub/a.txt')).toBe(false)
  })

  it('reads a negation and its escape', () => {
    expect(overrideGlob('!*.txt', false)?.keep).toBe(false)
    const literal = overrideGlob('\\!x', false)
    expect(literal?.keep).toBe(true)
    expect(literal?.matcher.test('!x')).toBe(true)
  })

  it('lets a trailing slash speak only for directories', () => {
    const glob = overrideGlob('sub/', false)
    expect(glob?.dirOnly).toBe(true)
    expect(glob?.matcher.test('sub')).toBe(true)
  })

  it('keeps below dir/** but not the directory', () => {
    const glob = overrideGlob('sub/**', false)
    expect(glob?.matcher.test('sub/d.txt')).toBe(true)
    expect(glob?.matcher.test('sub/deep/f.txt')).toBe(true)
    expect(glob?.matcher.test('sub')).toBe(false)
  })

  it('drops trailing spaces unless escaped', () => {
    expect(overrideGlob('*.py  ', false)?.matcher.test('a.py')).toBe(true)
    expect(overrideGlob('a\\ ', false)?.matcher.test('a ')).toBe(true)
  })
})

describe('Overrides', () => {
  it('lets the last matching glob decide', () => {
    // ripgrep 14.1.1: `-g '!*.txt' -g a.txt` keeps a.txt, the reverse order
    // drops it.
    expect(new Overrides(['!*.txt', 'a.txt'], [], false).verdict('a.txt', false)).toBe(
      Verdict.WHITELIST,
    )
    expect(new Overrides(['a.txt', '!*.txt'], [], false).verdict('a.txt', false)).toBe(
      Verdict.IGNORE,
    )
  })

  it('drops every file a plain glob does not match, but walks directories', () => {
    const overrides = new Overrides(['*.py'], [], false)
    expect(overrides.verdict('a.txt', false)).toBe(Verdict.IGNORE)
    expect(overrides.verdict('sub', true)).toBe(Verdict.NONE)
  })

  it('leaves the rest alone under only negated globs', () => {
    const overrides = new Overrides(['!*.txt'], [], false)
    expect(overrides.verdict('a.py', false)).toBe(Verdict.NONE)
    expect(overrides.verdict('a.txt', false)).toBe(Verdict.IGNORE)
  })

  it('folds case for --iglob, after every -g', () => {
    expect(new Overrides(['!*.py'], ['*.PY'], false).verdict('a.py', false)).toBe(Verdict.WHITELIST)
    expect(new Overrides(['*.PY'], [], true).verdict('a.py', false)).toBe(Verdict.WHITELIST)
  })

  it('says nothing with no globs', () => {
    expect(new Overrides([], [], false).verdict('a', false)).toBe(Verdict.NONE)
  })
})

describe('walkCandidate', () => {
  it.each([
    ['./sub/a.py', '/data', 'sub/a.py'],
    ['sub/a.py', '/data', 'sub/a.py'],
    ['/data/rgt/a.py', '/data', 'rgt/a.py'],
    ['/data/rgt/a.py', '/', 'data/rgt/a.py'],
    ['/elsewhere/a.py', '/data', '/elsewhere/a.py'],
  ])('matches %s from %s as %s', (shown, cwd, candidate) => {
    expect(walkCandidate(shown, cwd)).toBe(candidate)
  })
})

describe('ignoreLines', () => {
  const bytes = (...parts: number[]): Uint8Array => Uint8Array.from(parts)
  const enc = (text: string): Uint8Array => new TextEncoder().encode(text)
  it.each([
    [enc('a\r\nb\n'), false, ['a', 'b']],
    [enc('a\nb\r'), false, ['a', 'b\r']],
    [Uint8Array.from([...enc('one\n'), 0xff, ...enc('\ntwo\n')]), false, ['one']],
    [bytes(0xef, 0xbb, 0xbf, 0x61, 0x0a), true, ['a']],
    [bytes(0xef, 0xbb, 0xbf, 0x61, 0x0a), false, ['\ufeffa']],
    [new Uint8Array(), true, []],
  ])('reads %j as the ignore crate reads it', (data, bom, lines) => {
    expect(ignoreLines(data, bom)).toEqual(lines)
  })
})

describe('IgnoreStack', () => {
  const sources = (changes: Partial<IgnoreSources> = {}): IgnoreSources => ({
    vcs: true,
    exclude: true,
    dot: true,
    custom: '.rgignore',
    parents: true,
    requireGit: true,
    bom: false,
    ...changes,
  })
  const rules = (
    dir: string,
    hasGit = false,
    files: Partial<Record<'custom' | 'dot' | 'git' | 'exclude', string[]>> = {},
  ): DirRules => {
    const of = (name: 'custom' | 'dot' | 'git' | 'exclude'): IgnoreRules | null => {
      const lines = files[name]
      return lines === undefined ? null : new IgnoreRules(lines)
    }
    return {
      dir,
      hasGit,
      custom: of('custom'),
      dot: of('dot'),
      git: of('git'),
      exclude: of('exclude'),
    }
  }

  it('ranks by kind before depth', () => {
    const stack = new IgnoreStack(sources())
      .within(rules('/r', true, { dot: ['!keep.ts'] }))
      .within(rules('/r/sub', false, { git: ['keep.ts', 'drop.ts'] }))
    expect(stack.verdict('/r/sub/keep.ts', false)).toBe(Verdict.WHITELIST)
    expect(stack.verdict('/r/sub/drop.ts', false)).toBe(Verdict.IGNORE)
    expect(stack.verdict('/r/sub/plain.ts', false)).toBe(Verdict.NONE)
  })

  it('reads git files only inside a repository', () => {
    const outside = new IgnoreStack(sources()).within(rules('/r', false, { git: ['*.log'] }))
    expect(outside.verdict('/r/a.log', false)).toBe(Verdict.NONE)
    const unrequired = new IgnoreStack(sources({ requireGit: false })).within(
      rules('/r', false, { git: ['*.log'] }),
    )
    expect(unrequired.verdict('/r/a.log', false)).toBe(Verdict.IGNORE)
    const above = new IgnoreStack(sources())
      .within(rules('/', false, { git: ['*.log'] }))
      .within(rules('/r', true))
    expect(above.verdict('/r/a.log', false)).toBe(Verdict.NONE)
  })
})

describe('IgnoreRules with a line that does not compile', () => {
  it('keeps the lines around it', () => {
    const rules = new IgnoreRules(['[', '*.log', '# note', '{', '[z-a]', '[a-c]x'])
    expect(rules.verdict('a.log', false)).toBe(Verdict.IGNORE)
    expect(rules.verdict('bx', false)).toBe(Verdict.IGNORE)
    expect(rules.errors).toEqual([
      "line 1: error parsing glob '[': unclosed character class; missing ']'",
      "line 4: error parsing glob '{': unclosed alternate group; missing '}' (maybe escape '{' with '[{]'?)",
      "line 5: error parsing glob '[z-a]': invalid range; 'z' > 'a'",
    ])
  })
})

describe('Overrides with a root', () => {
  it.each([
    ['data', 'data/cache', Verdict.IGNORE],
    ['src', 'data/cache', Verdict.NONE],
    ['', 'cache', Verdict.IGNORE],
    ['.', 'data/cache', Verdict.NONE],
    ['data', 'cache', Verdict.IGNORE],
  ])('anchors a glob at %s for %s', (root, path, verdict) => {
    expect(new Overrides(['!/cache'], [], false, root).verdict(path, true)).toBe(verdict)
  })
})
