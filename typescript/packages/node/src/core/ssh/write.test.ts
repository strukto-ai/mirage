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
import { runWithRecording } from '@struktoai/mirage-core/observe/context'
import { PathSpec, VFSName } from '@struktoai/mirage-core/types'
import { makeFakeAccessor } from '../../../tests/core/ssh/_test_utils.ts'
import { read } from './read.ts'
import { write } from './write.ts'

function spec(p: string): PathSpec {
  return PathSpec.fromStrPath(p)
}

describe('core/ssh/write', () => {
  it('writes bytes to a new file', async () => {
    const accessor = makeFakeAccessor({
      files: new Map(),
      dirs: new Map([
        ['/', {}],
        ['/data', {}],
      ]),
    })
    await write(accessor, spec('/data/a.txt'), new TextEncoder().encode('hello'))
    const out = await read(accessor, spec('/data/a.txt'))
    expect(new TextDecoder().decode(out)).toBe('hello')
  })

  it('overwrites an existing file', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([['/data/a.txt', { data: new TextEncoder().encode('old') }]]),
      dirs: new Map([
        ['/', {}],
        ['/data', {}],
      ]),
    })
    await write(accessor, spec('/data/a.txt'), new TextEncoder().encode('new'))
    const out = await read(accessor, spec('/data/a.txt'))
    expect(new TextDecoder().decode(out)).toBe('new')
  })

  it('respects the configured root', async () => {
    const accessor = makeFakeAccessor(
      {
        files: new Map(),
        dirs: new Map([
          ['/srv', {}],
          ['/srv/data', {}],
        ]),
      },
      '/srv',
    )
    await write(accessor, spec('/data/a.txt'), new TextEncoder().encode('rooted'))
    const out = await read(accessor, spec('/data/a.txt'))
    expect(new TextDecoder().decode(out)).toBe('rooted')
  })

  it('records the write for command history', async () => {
    const accessor = makeFakeAccessor({
      files: new Map(),
      dirs: new Map([
        ['/', {}],
        ['/data', {}],
      ]),
    })
    const [, records] = await runWithRecording(async () => {
      await write(accessor, spec('/data/a.txt'), new TextEncoder().encode('hello'))
    })
    expect(records).toHaveLength(1)
    expect(records[0]?.op).toBe('write')
    expect(records[0]?.source).toBe(VFSName.SSH)
    expect(records[0]?.bytes).toBe(5)
  })
})

it.each([false, true])('commits an atomic streamed SSH write only after EOF: %s', async (fail) => {
  const old = new TextEncoder().encode('old')
  const files = new Map([['/data/a', { data: old, attrs: { mode: 0o100640 } }]])
  const accessor = makeFakeAccessor({
    files,
    dirs: new Map([
      ['/', {}],
      ['/data', {}],
    ]),
  })
  const sftp = await accessor.sftp()
  sftp.ext_openssh_rename = sftp.rename.bind(sftp)
  let closed = false
  async function* source(): AsyncGenerator<Uint8Array> {
    try {
      yield new TextEncoder().encode('first')
      expect(files.get('/data/a')?.data).toEqual(old)
      await Promise.resolve()
      if (fail) throw new Error('producer failed')
      yield new TextEncoder().encode('last')
    } finally {
      closed = true
    }
  }
  const result = write(accessor, spec('/data/a'), source(), undefined, true)
  if (fail) await expect(result).rejects.toThrow('producer failed')
  else await result
  expect([...files.keys()]).toEqual(['/data/a'])
  expect(new TextDecoder().decode(files.get('/data/a')?.data)).toBe(fail ? 'old' : 'firstlast')
  expect((files.get('/data/a')?.attrs.mode ?? 0) & 0o777).toBe(0o640)
  expect(closed).toBe(true)
})
