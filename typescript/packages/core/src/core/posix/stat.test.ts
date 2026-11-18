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
      "env LC_ALL=C find -L 'data/a b' -printf '%y %m %s %T@ %A@ %U %G %P\\0'",
    )
  })

  it('bounds the depth', () => {
    expect(treeCommand('/tmp', 1)).toBe(
      "env LC_ALL=C find -L '/tmp' -maxdepth 1 -printf '%y %m %s %T@ %A@ %U %G %P\\0'",
    )
  })
})

describe('parseTree', () => {
  it('reads each record', () => {
    const out = ENC.encode('d 755 4096 1700000000.5 1700000001.0 0 0 \0f 644 3 1 2 1000 50 x y\0')
    expect(parseTree(out)).toEqual([
      {
        kind: 'd',
        mode: 0o755,
        size: 4096,
        mtime: 1700000000,
        atime: 1700000001,
        mtimeMs: 1700000000500,
        atimeMs: 1700000001000,
        uid: 0,
        gid: 0,
        rel: '',
      },
      {
        kind: 'f',
        mode: 0o644,
        size: 3,
        mtime: 1,
        atime: 2,
        mtimeMs: 1000,
        atimeMs: 2000,
        uid: 1000,
        gid: 50,
        rel: 'x y',
      },
    ])
  })

  it.each<[string, number]>([
    ['1700000000.1234567890', 1700000000123],
    ['1.0004999999', 1000],
    ['1.0005000000', 1001],
    ['1.', 1000],
    ['-1.5000000000', -1500],
  ])('keeps %s to the millisecond', (stamp, want) => {
    const rows = parseTree(ENC.encode(`f 644 0 ${stamp} ${stamp} 0 0 x\0`))
    expect(rows?.map((r) => [r.mtimeMs, r.atimeMs])).toEqual([[want, want]])
  })

  // The whole seconds stay those SFTP reports, never rounded across a second
  // as the milliseconds are.
  it("keeps SFTP's whole seconds", () => {
    const rows = parseTree(ENC.encode('f 644 0 1700000000.9996 1700000000.9996 0 0 x\0'))
    expect(rows?.map((r) => [r.mtime, r.mtimeMs])).toEqual([[1700000000, 1700000001000]])
  })

  it('refuses a cut record', () => {
    expect(parseTree(ENC.encode('f 644 3 1 2 0 0 x'))).toBeNull()
    expect(parseTree(ENC.encode('f 64z 3 1 2 0 0 x\0'))).toBeNull()
    expect(parseTree(ENC.encode('f 644 3 1 2 root root x\0'))).toBeNull()
  })
})
