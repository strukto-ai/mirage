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

import { IgnoreStack } from './ignore.ts'

const ENC = new TextEncoder()

const RULES = [
  '*.log',
  'build/',
  '/root-only.txt',
  'docs/*.tmp',
  '!keep.log',
  '**/deep/',
  'nested/**/x.txt',
  'sp?ce.txt',
  '[abc]set.txt',
].join('\n')

const stack = (): IgnoreStack => new IgnoreStack().push('', ENC.encode(RULES))

// Every row is what `git check-ignore` answered for the same rules on a real
// repository (git 2.50.1), path then whether git ignores it, and whether the
// path names a directory.
const CASES: [string, boolean, boolean][] = [
  ['a.log', true, false],
  // The negation comes after `*.log`, and the last matching pattern wins.
  ['keep.log', false, false],
  // A leading slash anchors to the file's own directory.
  ['root-only.txt', true, false],
  ['sub/root-only.txt', false, false],
  ['build', true, true],
  ['build/x', true, false],
  ['docs/n.tmp', true, false],
  ['docs/n.md', false, false],
  // `**` crosses directories where a bare `*` would not.
  ['nested/a/b/x.txt', true, false],
  ['sub/deep', true, true],
  ['sub/deep/z', true, false],
  // `?` matches exactly one non-slash character.
  ['spXce.txt', true, false],
  ['aset.txt', true, false],
  ['dset.txt', false, false],
]

describe('IgnoreStack', () => {
  it.each(CASES)('matches git check-ignore for %s', (path, ignored, isDir) => {
    expect(stack().isIgnored(path, isDir)).toBe(ignored)
  })

  it('lets a deeper file override a shallower one', () => {
    // Precedence runs deepest-first, which is why the search runs from the end
    // of the stack rather than the front.
    const nested = new IgnoreStack()
      .push('', ENC.encode('*.log'))
      .push('sub', ENC.encode('!keep.log'))
    expect(nested.isIgnored('a.log')).toBe(true)
    expect(nested.isIgnored('sub/keep.log')).toBe(false)
    expect(nested.isIgnored('sub/other.log')).toBe(true)
  })

  it('leaves a path alone when a nested file governs another directory', () => {
    const nested = new IgnoreStack().push('other', ENC.encode('*.log'))
    expect(nested.isIgnored('sub/a.log')).toBe(false)
    expect(nested.isIgnored('other/a.log')).toBe(true)
  })

  it('skips comments and blank lines', () => {
    const commented = new IgnoreStack().push('', ENC.encode('# *.log\n\n*.tmp\n'))
    expect(commented.isIgnored('a.log')).toBe(false)
    expect(commented.isIgnored('a.tmp')).toBe(true)
  })

  it('ignores nothing when no file was pushed', () => {
    expect(new IgnoreStack().isIgnored('anything')).toBe(false)
  })

  it('never lets a directory-only pattern catch a file', () => {
    const dirs = new IgnoreStack().push('', ENC.encode('build/'))
    expect(dirs.isIgnored('build', false)).toBe(false)
    expect(dirs.isIgnored('build', true)).toBe(true)
  })
})
