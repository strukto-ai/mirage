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
import type { Accessor } from '../../../../accessor/base.ts'
import { RAMIndexCacheStore } from '../../../../cache/index/ram.ts'
import type { IndexCacheStore } from '../../../../cache/index/store.ts'
import { materialize } from '../../../../io/types.ts'
import { FileStat, FileType, PathSpec } from '../../../../types.ts'
import { eacces, enoent } from '../../../../errors/fs.ts'
import type { CommandIO } from '../adapter.ts'
import { BUILDER } from './unlink.ts'

const DEC = new TextDecoder()
const INDEX = new RAMIndexCacheStore()

// eslint-disable-next-line @typescript-eslint/require-await
async function* emptyStream(): AsyncIterable<Uint8Array> {
  yield* []
}

function ops(removed?: string[]): CommandIO {
  const remove = (_a: Accessor, p: PathSpec): Promise<void> => {
    removed?.push(p.virtual)
    return Promise.resolve()
  }
  return {
    readdir: (_a, p) => Promise.resolve(p.virtual === '/m' ? ['/m/a.txt', '/m/locked'] : []),
    readBytes: () => Promise.resolve(new Uint8Array()),
    readStream: () => emptyStream(),
    // Served from the index, as github's is: a stat handed none finds
    // nothing, however real the file.
    stat: (_a, p, index?: IndexCacheStore) => {
      if (index !== INDEX) return Promise.reject(enoent(p.virtual))
      if (p.virtual.startsWith('/m/locked/')) return Promise.reject(eacces(p.virtual))
      if (p.virtual === '/m/a.txt') {
        return Promise.resolve(new FileStat({ name: p.virtual, type: FileType.FILE }))
      }
      return Promise.reject(enoent(p.virtual))
    },
    isMounted: () => true,
    ...(removed === undefined ? {} : { unlink: remove }),
  }
}

async function unlink(io: CommandIO, path: string): Promise<[number, string]> {
  const result = await BUILDER.fn(io, {} as Accessor, [PathSpec.fromStrPath(path)], [], {
    stdin: null,
    flags: {},
    filetypeFns: null,
    cwd: '/',
    index: INDEX,
  })
  if (result === null) throw new Error('unlink returned no result')
  const [, res] = result
  return [res.exitCode, DEC.decode(await materialize(res.stderr))]
}

describe('unlink builder', () => {
  it('stats its operand through the index', async () => {
    const removed: string[] = []
    expect(await unlink(ops(removed), '/m/a.txt')).toEqual([0, ''])
    expect(removed).toEqual(['/m/a.txt'])
  })

  it('reports an existing file it cannot remove', async () => {
    expect(await unlink(ops(), '/m/a.txt')).toEqual([
      1,
      "unlink: cannot unlink '/m/a.txt': Operation not supported\n",
    ])
  })

  it('reports a refused stat in its own words', async () => {
    expect(await unlink(ops(), '/m/locked/f.txt')).toEqual([
      1,
      "unlink: cannot unlink '/m/locked/f.txt': Permission denied\n",
    ])
  })
})
