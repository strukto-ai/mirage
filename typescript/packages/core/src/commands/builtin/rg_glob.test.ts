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
import { Overrides, Verdict, compileGlob, overrideGlob, walkCandidate } from './rg_glob.ts'

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
