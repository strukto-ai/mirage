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

import { DU_BUILDER } from './du.ts'
import { describe, expect, it } from 'vitest'
import { materialize } from '../../../../io/types.ts'
import { FileStat, FileType, PathSpec } from '../../../../types.ts'
import type { Accessor } from '../../../../accessor/base.ts'
import type { CommandIO } from '../adapter.ts'

const DEC = new TextDecoder()

const TREE: Record<string, { dir: boolean; size?: number; children?: string[] }> = {
  '/db': { dir: true, children: ['/db/a.txt', '/db/sub'] },
  '/db/a.txt': { dir: false, size: 3 },
  '/db/sub': { dir: true, children: ['/db/sub/b.txt'] },
  '/db/sub/b.txt': { dir: false, size: 2 },
}

// A CommandIO with no native du op, so the builder must use the walk fallback.
// eslint-disable-next-line @typescript-eslint/require-await
async function* emptyStream(): AsyncIterable<Uint8Array> {
  yield* []
}

const OPS: CommandIO = {
  readdir: (_a, p) => Promise.resolve(TREE[p.original]?.children ?? []),
  readBytes: () => Promise.resolve(new Uint8Array()),
  readStream: () => emptyStream(),
  stat: (_a, p) => {
    const node = TREE[p.original]
    if (node === undefined) return Promise.reject(new Error('ENOENT'))
    return Promise.resolve(
      new FileStat({
        name: p.original,
        type: node.dir ? FileType.DIRECTORY : FileType.TEXT,
        size: node.size ?? null,
      }),
    )
  },
  isMounted: () => true,
}

const ACCESSOR = {} as Accessor

async function runDu(
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]> = {},
): Promise<string[]> {
  const result = await DU_BUILDER.fn(OPS, ACCESSOR, paths, [], {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource: {} as never,
  })
  if (result === null) return []
  const [out] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  const text = DEC.decode(buf)
  return text === '' ? [] : text.trimEnd().split('\n')
}

describe('du walk fallback (no native du op)', () => {
  it('sums a directory tree recursively', async () => {
    expect(await runDu([PathSpec.fromStrPath('/db')])).toEqual(['5\t/db'])
  })

  it('returns a single file size', async () => {
    expect(await runDu([PathSpec.fromStrPath('/db/a.txt')])).toEqual(['3\t/db/a.txt'])
  })

  it('-a collapses to the directory total (compute_all=None path)', async () => {
    expect(await runDu([PathSpec.fromStrPath('/db')], { a: true })).toEqual(['5\t/db'])
  })

  it('-c appends a grand total across operands', async () => {
    const lines = await runDu(
      [PathSpec.fromStrPath('/db/a.txt'), PathSpec.fromStrPath('/db/sub')],
      { c: true },
    )
    expect(lines).toEqual(['3\t/db/a.txt', '2\t/db/sub', '5\ttotal'])
  })

  it('missing path counts as 0', async () => {
    expect(await runDu([PathSpec.fromStrPath('/nope')])).toEqual(['0\t/nope'])
  })

  it('-h renders human-readable sizes', async () => {
    expect(await runDu([PathSpec.fromStrPath('/db')], { h: true })).toEqual(['5B\t/db'])
  })
})
