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

import { FIND_BUILDER } from './find.ts'
import { describe, expect, it } from 'vitest'
import { materialize } from '../../../../io/types.ts'
import { FileStat, FileType, PathSpec } from '../../../../types.ts'
import { enoent } from '../../../../utils/errors.ts'
import { epochToIsoZ } from '../../../../utils/dates.ts'
import type { Accessor } from '../../../../accessor/base.ts'
import type { FindOptions } from '../../../../vfs/base.ts'
import type { CommandIO } from '../adapter.ts'

const DEC = new TextDecoder()

const TREE: Record<string, string[] | null> = {
  '/mnt': ['/mnt/table1', '/mnt/notes.txt'],
  '/mnt/table1': ['/mnt/table1/rows.jsonl'],
  '/mnt/notes.txt': null,
  '/mnt/table1/rows.jsonl': null,
}

// eslint-disable-next-line @typescript-eslint/require-await
async function* emptyStream(): AsyncIterable<Uint8Array> {
  yield* []
}

// A remote backend with a native find op that ignores the window it is
// handed, so a pushed-down window shows as rows the overlay would drop.
function remoteOps(pushed: FindOptions[]): CommandIO {
  return {
    readdir: (_a, p) => Promise.resolve(TREE[p.virtual] ?? []),
    readBytes: () => Promise.resolve(new Uint8Array()),
    readStream: () => emptyStream(),
    stat: (_a, p) => {
      if (!(p.virtual in TREE)) return Promise.reject(enoent(p.virtual))
      return Promise.resolve(
        new FileStat({
          name: p.virtual,
          type: TREE[p.virtual] === null ? FileType.FILE : FileType.DIRECTORY,
          size: 3,
          modified: '2099-01-01T00:00:00Z',
        }),
      )
    },
    isMounted: () => true,
    local: false,
    find: (_a, _root, options) => {
      pushed.push(options)
      return Promise.resolve(['/notes.txt', '/table1/rows.jsonl'])
    },
  }
}

const touched = (virtual: string, stat: FileStat): FileStat =>
  virtual === '/mnt/notes.txt' ? stat.with({ modified: epochToIsoZ(1704067200) }) : stat

async function newerThanMid2024(holdsTimes: boolean): Promise<[string[], FindOptions[]]> {
  const pushed: FindOptions[] = []
  const root = new PathSpec({ virtual: '/mnt', directory: '/mnt', resolved: false, vfsPath: '' })
  const result = await FIND_BUILDER.fn(
    remoteOps(pushed),
    {} as Accessor,
    [root],
    ['-type', 'f', '-newermt', '2024-06-01'],
    {
      stdin: null,
      flags: {},
      filetypeFns: null,
      cwd: '/',
      ns: { statOverlay: touched, timesUnder: () => holdsTimes },
    },
  )
  if (result === null) return [[], pushed]
  const [out] = result
  const buf = out === null ? new Uint8Array() : await materialize(out as AsyncIterable<Uint8Array>)
  const text = DEC.decode(buf)
  return [text === '' ? [] : text.trimEnd().split('\n'), pushed]
}

describe('find on a remote backend with a native find op', () => {
  it('judges times by the overlay that holds them', async () => {
    const [lines, pushed] = await newerThanMid2024(true)
    expect(pushed[0]?.mtimeMin).toBeUndefined()
    expect(lines).toEqual(['/mnt/table1/rows.jsonl'])
  })

  it('pushes the window down without overlay times', async () => {
    const [, pushed] = await newerThanMid2024(false)
    expect(pushed[0]?.mtimeMin).toBeDefined()
  })
})
