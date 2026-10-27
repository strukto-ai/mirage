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

import { expect, it } from 'vitest'

import { hashOrder, selects, upstreamPatterns } from './branch.ts'

// The order git 2.56.0's --delete-merged deleted these in, each list given in
// the refname order the branches were found in. Mirrors test_branch.py.
it.each([
  [
    ['x', 'y', 'z'],
    ['z', 'y', 'x'],
  ],
  [
    ['Fix-1', 'feat/a', 'feat/b', 'fix-2', 'plain'],
    ['plain', 'Fix-1', 'feat/a', 'feat/b', 'fix-2'],
  ],
  [
    Array.from({ length: 52 }, (_, n) => `b${String(n).padStart(2, '0')}`),
    (
      'b38 b39 b34 b35 b36 b37 b30 b31 b32 b33 b12 b13 b10 b11 b16 b17' +
      ' b14 b15 b18 b19 b29 b28 b27 b26 b25 b24 b23 b22 b21 b20 b49 b48' +
      ' b41 b40 b43 b42 b45 b44 b47 b46 b50 b51 b05 b04 b07 b06 b01 b00' +
      ' b03 b02 b09 b08'
    ).split(' '),
  ],
])('deletes merged branches in git hash order: %j', (names, order) => {
  expect(hashOrder(names)).toEqual(order)
})

const TABLE = new Map([
  ['HEAD', 'ref: refs/heads/main'],
  ['refs/heads/main', 'a'.repeat(40)],
  ['refs/remotes/origin/HEAD', 'ref: refs/remotes/origin/main'],
  ['refs/remotes/origin/main', 'a'.repeat(40)],
  ['refs/tags/v1', 'a'.repeat(40)],
])
const KNOWN = new Set(TABLE.keys())

it.each([
  ['origin', 'refs/remotes/origin/main', true],
  ['HEAD', 'refs/heads/main', true],
  ['@', 'refs/remotes/origin/main', false],
  ['origin/*', 'refs/remotes/origin/main', true],
  ['*', 'refs/remotes/origin/main', false],
  ['*', 'refs/heads/main', true],
  ['origin/**', 'refs/remotes/origin/gone', true],
  ['ORIGIN/*', 'refs/remotes/origin/main', false],
])('an upstream pattern %s names a branch or globs one', (pattern, upstream, chosen) => {
  expect(selects(upstreamPatterns(TABLE, KNOWN, [pattern]), upstream)).toBe(chosen)
})

it.each(['v1', 'nosuch', 'origin/', ''])(
  'an upstream pattern must name a branch: %j',
  (pattern) => {
    expect(() => upstreamPatterns(TABLE, KNOWN, [pattern])).toThrow(
      'is not a valid branch or pattern',
    )
  },
)
