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
import { removalLines } from './verbose.ts'

describe('removalLines', () => {
  it('emits children before parents on a chain', () => {
    expect(
      removalLines([
        { path: '/data/lin', isDir: true },
        { path: '/data/lin/sub', isDir: true },
        { path: '/data/lin/sub/z.txt', isDir: false },
      ]),
    ).toEqual([
      "removed '/data/lin/sub/z.txt'",
      "removed directory '/data/lin/sub'",
      "removed directory '/data/lin'",
    ])
  })

  it('is deterministic regardless of input order', () => {
    expect(
      removalLines([
        { path: '/data/t', isDir: true },
        { path: '/data/t/b.txt', isDir: false },
        { path: '/data/t/a.txt', isDir: false },
      ]),
    ).toEqual(["removed '/data/t/b.txt'", "removed '/data/t/a.txt'", "removed directory '/data/t'"])
  })

  it('renders a single file, strips trailing slashes, and handles an empty list', () => {
    expect(removalLines([{ path: '/data/f.txt', isDir: false }])).toEqual(["removed '/data/f.txt'"])
    expect(removalLines([{ path: '/data/dir///', isDir: true }])).toEqual([
      "removed directory '/data/dir'",
    ])
    expect(removalLines([])).toEqual([])
  })
})

describe('removalLines ordering is by code point, reversed', () => {
  // The reversal is load-bearing: '/' is 0x2F, below every name character,
  // so an ascending path sort is a pre-order walk and its reverse is a valid
  // post-order one. GNU `sort` on 'a/b', 'a', 'ab' gives a, a/b, ab, so a
  // descendant always precedes its directory under the reverse.
  it('still reports children before parents across a branching tree', () => {
    expect(
      removalLines([
        { path: '/data/t', isDir: true },
        { path: '/data/t/ab', isDir: false },
        { path: '/data/t/a', isDir: true },
        { path: '/data/t/a/b.txt', isDir: false },
      ]),
    ).toEqual([
      "removed '/data/t/ab'",
      "removed '/data/t/a/b.txt'",
      "removed directory '/data/t/a'",
      "removed directory '/data/t'",
    ])
  })

  // U+1D11E is astral: its first UTF-16 unit is D834, which compares BELOW
  // U+FFFD, so a `<`/`>` comparator reverses these two. GNU sorts by byte,
  // which is code-point order, putting U+FFFD first ascending and therefore
  // U+1D11E first here. Without an astral character the test cannot tell
  // the two orders apart.
  it('orders an astral name by code point, not by UTF-16 code unit', () => {
    expect(
      removalLines([
        { path: '/d/z', isDir: false },
        { path: '/d/\u{1D11E}', isDir: false },
        { path: '/d/\uFFFD', isDir: false },
      ]),
    ).toEqual(["removed '/d/\u{1D11E}'", "removed '/d/\uFFFD'", "removed '/d/z'"])
  })
})
