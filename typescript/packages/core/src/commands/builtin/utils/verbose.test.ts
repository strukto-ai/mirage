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
