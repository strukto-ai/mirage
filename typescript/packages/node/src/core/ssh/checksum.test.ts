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
import { PathSpec } from '@struktoai/mirage-core/types'
import { RunAccessor, type RunAnswer } from './_test_utils.ts'
import { checksum } from './checksum.ts'

const ENC = new TextEncoder()
const SHA256 = 'a'.repeat(64)

function file(vfsPath: string): PathSpec {
  return new PathSpec({
    virtual: `/s/${vfsPath}`,
    directory: '/s',
    vfsPath,
    rawPath: `/s/${vfsPath}`,
  })
}

describe('checksum', () => {
  it.each([
    ['md5', 'md5sum', '0'.repeat(32)],
    ['sha1', 'sha1sum', '1'.repeat(40)],
    ['sha256', 'sha256sum', SHA256],
    ['sha384', 'sha384sum', '3'.repeat(96)],
    ['sha512', 'sha512sum', '5'.repeat(128)],
  ])("is what the server's sum prints for %s", async (algorithm, tool, digest) => {
    const accessor = new RunAccessor('data', [0, ENC.encode(`${digest}  -\n`), new Uint8Array()])
    expect(await checksum(accessor, file('a b.txt'), algorithm)).toBe(digest)
    expect(accessor.sent).toEqual([`${tool} < 'data/a b.txt'`])
  })

  it('reads an algorithm with no tool without a command', async () => {
    const accessor = new RunAccessor('data', [0, new Uint8Array(), new Uint8Array()])
    expect(await checksum(accessor, file('x'), 'blake2b')).toBeNull()
    expect(accessor.sent).toEqual([])
  })

  it.each<[string, RunAnswer]>([
    ['a directory', [1, new Uint8Array(), ENC.encode('sha256sum: -: Is a directory\n')]],
    [
      'a missing file',
      [1, new Uint8Array(), ENC.encode('sh: data/x: No such file or directory\n')],
    ],
    ['stderr', [0, ENC.encode(`${SHA256}  -\n`), ENC.encode('warning\n')]],
    ['binary mode', [0, ENC.encode(`${SHA256} *-\n`), new Uint8Array()]],
    ['no newline', [0, ENC.encode(`${SHA256}  -`), new Uint8Array()]],
    ['a short digest', [0, ENC.encode(`${SHA256.slice(1)}  -\n`), new Uint8Array()]],
    ['a non-hex digest', [0, ENC.encode(`${SHA256.slice(1)}G  -\n`), new Uint8Array()]],
    ['an uppercase digest', [0, ENC.encode(`${SHA256.toUpperCase()}  -\n`), new Uint8Array()]],
    [
      'a refused command',
      [127, new Uint8Array(), ENC.encode("only the mount's own commands run here\n")],
    ],
    ['a closed connection', new Error('closed')],
  ])('leaves the read on %s', async (_name, answer) => {
    expect(await checksum(new RunAccessor('data', answer), file('x'), 'sha256')).toBeNull()
  })
})
