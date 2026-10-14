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
import { RunAccessor, makeFakeAccessor, type RunAnswer } from './_test_utils.ts'
import { lineCount, read } from './read.ts'

function spec(p: string): PathSpec {
  return PathSpec.fromStrPath(p)
}

function file(vfsPath: string): PathSpec {
  return new PathSpec({
    virtual: `/s/${vfsPath}`,
    directory: '/s',
    vfsPath,
    rawPath: `/s/${vfsPath}`,
  })
}

describe('core/ssh/read', () => {
  it('returns file bytes for an existing file', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([['/data/a.txt', { data: new TextEncoder().encode('hello') }]]),
      dirs: new Map([
        ['/', {}],
        ['/data', {}],
      ]),
    })
    const data = await read(accessor, spec('/data/a.txt'))
    expect(new TextDecoder().decode(data)).toBe('hello')
  })

  it('throws ENOENT for a missing file', async () => {
    const accessor = makeFakeAccessor({
      files: new Map(),
      dirs: new Map([['/', {}]]),
    })
    await expect(read(accessor, spec('/missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('joins the configured root with the virtual path', async () => {
    const accessor = makeFakeAccessor(
      {
        files: new Map([['/srv/data/a.txt', { data: new TextEncoder().encode('rooted') }]]),
        dirs: new Map([
          ['/srv', {}],
          ['/srv/data', {}],
        ]),
      },
      '/srv',
    )
    const data = await read(accessor, spec('/data/a.txt'))
    expect(new TextDecoder().decode(data)).toBe('rooted')
  })
})

describe('lineCount', () => {
  const ENC = new TextEncoder()

  it.each(['42\n', '     42\n'])('is what wc counts (%j)', async (out) => {
    const accessor = new RunAccessor('data', [0, ENC.encode(out), new Uint8Array()])
    expect(await lineCount(accessor, file('a b.txt'))).toBe(42)
    expect(accessor.sent).toEqual(["env LC_ALL=C wc -l < 'data/a b.txt'"])
  })

  it.each<[string, RunAnswer]>([
    ['a directory', [1, new Uint8Array(), ENC.encode("wc: 'standard input': Is a directory\n")]],
    [
      'a missing file',
      [1, new Uint8Array(), ENC.encode('sh: data/x: No such file or directory\n')],
    ],
    ['stderr', [0, ENC.encode('3\n'), ENC.encode('warning\n')]],
    ['no newline', [0, ENC.encode('3'), new Uint8Array()]],
    ['two words', [0, ENC.encode('3 x\n'), new Uint8Array()]],
    [
      'a refused command',
      [127, new Uint8Array(), ENC.encode("only the mount's own commands run here\n")],
    ],
    ['a closed connection', new Error('closed')],
  ])('leaves the read on %s', async (_name, answer) => {
    expect(await lineCount(new RunAccessor('data', answer), file('x'))).toBeNull()
  })
})
