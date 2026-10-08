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
import type { CommandIO } from '../../../config.ts'
import { BUILDER } from './rm.ts'

const DEC = new TextDecoder()
const INDEX = new RAMIndexCacheStore()
const TREE: Record<string, string[]> = {
  '/m': ['/m/a.txt', '/m/d', '/m/locked'],
  '/m/d': ['/m/d/x.txt'],
  '/m/locked': ['/m/locked/f.txt'],
}
const FILES = new Set(['/m/a.txt', '/m/d/x.txt', '/m/locked/f.txt'])

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
    readdir: (_a, p) => Promise.resolve(TREE[p.virtual] ?? []),
    readBytes: () => Promise.resolve(new Uint8Array()),
    readStream: () => emptyStream(),
    // Served from the index, as github's is: a stat handed none finds
    // nothing, however real the file.
    stat: (_a, p, index?: IndexCacheStore) => {
      if (index !== INDEX) return Promise.reject(enoent(p.virtual))
      if (p.virtual.startsWith('/m/locked/')) return Promise.reject(eacces(p.virtual))
      if (TREE[p.virtual] !== undefined) {
        return Promise.resolve(new FileStat({ name: p.virtual, type: FileType.DIRECTORY }))
      }
      if (FILES.has(p.virtual)) {
        return Promise.resolve(new FileStat({ name: p.virtual, type: FileType.FILE }))
      }
      return Promise.reject(enoent(p.virtual))
    },
    isMounted: () => true,
    ...(removed === undefined ? {} : { unlink: remove, rmR: remove }),
  }
}

async function rm(
  io: CommandIO,
  paths: string[],
  flags: Record<string, boolean> = {},
): Promise<[number, string, string]> {
  const result = await BUILDER.fn(
    io,
    {} as Accessor,
    paths.map((p) => PathSpec.fromStrPath(p)),
    [],
    { stdin: null, flags, filetypeFns: null, cwd: '/', index: INDEX },
  )
  if (result === null) throw new Error('rm returned no result')
  const [out, res] = result
  return [
    res.exitCode,
    DEC.decode(await materialize(out)),
    DEC.decode(await materialize(res.stderr)),
  ]
}

describe('rm builder', () => {
  it('stats its operand through the index', async () => {
    const removed: string[] = []
    expect(await rm(ops(removed), ['/m/a.txt'])).toEqual([0, '', ''])
    expect(removed).toEqual(['/m/a.txt'])
  })

  it('-v walks the tree through the index', async () => {
    const removed: string[] = []
    expect(await rm(ops(removed), ['/m/d'], { r: true, v: true })).toEqual([
      0,
      "removed '/m/d/x.txt'\nremoved directory '/m/d'\n",
      '',
    ])
    expect(removed).toEqual(['/m/d'])
  })

  it('-f reports an existing file it cannot remove', async () => {
    // GNU's `ignorable_missing` spares ENOENT and ENOTDIR alone: a file
    // that exists on a filesystem refusing the unlink fails under -f too.
    expect(await rm(ops(), ['/m/a.txt', '/m/nope'], { f: true })).toEqual([
      1,
      '',
      "rm: cannot remove '/m/a.txt': Operation not supported\n",
    ])
  })

  it('reports a refused stat in its own words and removes the rest', async () => {
    const removed: string[] = []
    expect(await rm(ops(removed), ['/m/locked/f.txt', '/m/a.txt'], { f: true })).toEqual([
      1,
      '',
      "rm: cannot remove '/m/locked/f.txt': Permission denied\n",
    ])
    expect(removed).toEqual(['/m/a.txt'])
  })
})
