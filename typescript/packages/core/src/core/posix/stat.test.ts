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
import { parseTree, treeCommand } from './stat.ts'

const ENC = new TextEncoder()

describe('treeCommand', () => {
  it('quotes the scope and the format', () => {
    expect(treeCommand('data/a b')).toBe(
      "env LC_ALL=C find -L 'data/a b' -printf '%y %m %s %T@ %A@ %u %g %P\\0'",
    )
  })

  it('bounds the depth', () => {
    expect(treeCommand('/tmp', 1)).toBe(
      "env LC_ALL=C find -L '/tmp' -maxdepth 1 -printf '%y %m %s %T@ %A@ %u %g %P\\0'",
    )
  })
})

describe('parseTree', () => {
  it('reads each record', () => {
    const out = ENC.encode('d 755 4096 1700000000.5 1700000001.0 root root \0f 644 3 1 2 a b x y\0')
    expect(parseTree(out)).toEqual([
      {
        kind: 'd',
        mode: 0o755,
        size: 4096,
        mtime: 1700000000,
        atime: 1700000001,
        user: 'root',
        group: 'root',
        rel: '',
      },
      { kind: 'f', mode: 0o644, size: 3, mtime: 1, atime: 2, user: 'a', group: 'b', rel: 'x y' },
    ])
  })

  it('refuses a cut record', () => {
    expect(parseTree(ENC.encode('f 644 3 1 2 a b x'))).toBeNull()
    expect(parseTree(ENC.encode('f 64z 3 1 2 a b x\0'))).toBeNull()
  })
})
