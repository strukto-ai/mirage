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
import {
  CycleError,
  expandTilde,
  globPrefixMatch,
  posixNormpath,
  resolvePath,
  resolveSymlinks,
} from './path.ts'

describe('resolveSymlinks', () => {
  it('substitutes the longest matching link prefix', () => {
    const links = new Map([['/a/link', '/a/real']])
    expect(resolveSymlinks('/a/link/f.txt', links)).toBe('/a/real/f.txt')
    expect(resolveSymlinks('/a/link', links)).toBe('/a/real')
  })

  it('resolves a relative target against the link directory', () => {
    const links = new Map([['/a/link', 'real']])
    expect(resolveSymlinks('/a/link', links)).toBe('/a/real')
  })

  it('respects path-segment boundaries', () => {
    const links = new Map([['/a/b', '/x']])
    expect(resolveSymlinks('/a/bc', links)).toBe('/a/bc')
  })

  it('is identity with no links', () => {
    expect(resolveSymlinks('/a/b', new Map())).toBe('/a/b')
  })

  it('throws CycleError on a loop', () => {
    const links = new Map([
      ['/a', '/b'],
      ['/b', '/a'],
    ])
    expect(() => resolveSymlinks('/a', links)).toThrow(CycleError)
  })
})

describe('expandTilde', () => {
  it('~ alone → home', () => {
    expect(expandTilde('~', '/home/u')).toBe('/home/u')
  })

  it('~/sub → home/sub', () => {
    expect(expandTilde('~/file.txt', '/home/u')).toBe('/home/u/file.txt')
  })

  it('~/sub with root home', () => {
    expect(expandTilde('~/file.txt', '/')).toBe('/file.txt')
  })

  it('~user left unchanged', () => {
    expect(expandTilde('~other/x', '/home/u')).toBe('~other/x')
  })

  it('non-leading ~ left unchanged', () => {
    expect(expandTilde('a~b', '/home/u')).toBe('a~b')
  })

  it('plain word left unchanged', () => {
    expect(expandTilde('file.txt', '/home/u')).toBe('file.txt')
  })
})

describe('globPrefixMatch', () => {
  it('matches a basename glob in the same directory only', () => {
    expect(globPrefixMatch('/a/x.log', '/a/*.log')).toBe(true)
    expect(globPrefixMatch('/a/x.txt', '/a/*.log')).toBe(false)
    expect(globPrefixMatch('/a/d/x.log', '/a/*.log')).toBe(false)
  })

  it('covers descendants of a matched directory', () => {
    expect(globPrefixMatch('/a/dir/deep/x.txt', '/a/d*')).toBe(true)
    expect(globPrefixMatch('/a/other/x.txt', '/a/d*')).toBe(false)
  })

  it('matches intermediate segment globs', () => {
    expect(globPrefixMatch('/a/one/b.txt', '/a/*/b.txt')).toBe(true)
    expect(globPrefixMatch('/a/one/c.txt', '/a/*/b.txt')).toBe(false)
  })
})

describe('posixNormpath', () => {
  it('normalizes ..', () => {
    expect(posixNormpath('/a/b/../c')).toBe('/a/c')
  })

  it('collapses redundant slashes', () => {
    expect(posixNormpath('/a//b')).toBe('/a/b')
  })

  it('drops trailing slash', () => {
    expect(posixNormpath('/a/b/')).toBe('/a/b')
  })

  it('handles relative paths', () => {
    expect(posixNormpath('a/./b/../c')).toBe('a/c')
  })

  it('empty string becomes .', () => {
    expect(posixNormpath('')).toBe('.')
  })
})

describe('resolvePath', () => {
  it('passes through absolute paths', () => {
    expect(resolvePath('/abs/path', '/cwd')).toBe('/abs/path')
  })

  it('joins relative paths with cwd', () => {
    expect(resolvePath('file.txt', '/cwd/sub')).toBe('/cwd/sub/file.txt')
  })

  it('normalizes .. segments', () => {
    expect(resolvePath('../file.txt', '/cwd/sub')).toBe('/cwd/file.txt')
  })
})
