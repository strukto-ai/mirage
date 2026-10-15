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
import type { SFTPWrapper } from 'ssh2'
import { PathSpec } from '@struktoai/mirage-core/types'
import { copy, dirCopy } from './copy.ts'
import { exists } from './exists.ts'
import { makeFakeAccessor, RunAccessor, type RunAnswer } from './_test_utils.ts'
import { read } from './read.ts'

function spec(p: string): PathSpec {
  return PathSpec.fromStrPath(p)
}

describe('core/ssh/copy', () => {
  it('copies a file (src remains, dst has the same bytes)', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([['/data/a.txt', { data: new TextEncoder().encode('hello') }]]),
      dirs: new Map([
        ['/', {}],
        ['/data', {}],
      ]),
    })
    await copy(accessor, spec('/data/a.txt'), spec('/data/b.txt'))
    expect(await exists(accessor, spec('/data/a.txt'))).toBe(true)
    const out = await read(accessor, spec('/data/b.txt'))
    expect(new TextDecoder().decode(out)).toBe('hello')
  })

  it('throws ENOENT when source missing', async () => {
    const accessor = makeFakeAccessor({
      files: new Map(),
      dirs: new Map([
        ['/', {}],
        ['/data', {}],
      ]),
    })
    await expect(copy(accessor, spec('/data/missing'), spec('/data/x'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

const ENC = new TextEncoder()

async function copyTree(answer: RunAnswer, landed = false): Promise<RunAccessor> {
  const sftp = {
    exists: (_path: string, cb: (yes: boolean) => void) => {
      cb(landed)
    },
  } as unknown as SFTPWrapper
  const accessor = new RunAccessor('/srv', answer, sftp)
  await dirCopy(accessor, spec('/a b'), spec('/c'))
  return accessor
}

describe('core/ssh/copy dirCopy', () => {
  it('copies the tree with one cp on the server', async () => {
    const accessor = await copyTree([0, ENC.encode('copied\n'), new Uint8Array()])
    expect(accessor.sent).toEqual(["env LC_ALL=C cp -RL -- '/srv/a b' '/srv/c' && echo copied"])
  })

  it.each<[string, RunAnswer]>([
    [
      'a server that runs nothing',
      [1, ENC.encode('This service allows sftp connections only.\n'), new Uint8Array()],
    ],
    ['a refused exec', new Error('refused')],
  ])('leaves the walk on %s', async (_name, answer) => {
    await expect(copyTree(answer)).rejects.toMatchObject({ code: 'ENOTSUP' })
  })

  it('says why a cp that failed partway failed', async () => {
    const err = ENC.encode("cp: cannot open '/srv/a b/x' for reading: Permission denied\n")
    await expect(copyTree([1, new Uint8Array(), err], true)).rejects.toMatchObject({
      code: 'EACCES',
    })
  })
})
