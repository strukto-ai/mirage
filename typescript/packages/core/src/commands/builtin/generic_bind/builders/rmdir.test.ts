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
import { runWithMountGate } from '../../../../context/session_context.ts'
import { materialize } from '../../../../io/types.ts'
import { FileStat, FileType, MountMode, PathSpec } from '../../../../types.ts'
import { eacces, enoent } from '../../../../errors/fs.ts'
import { answeringFiles } from '../../../../test-utils.ts'
import type { Files } from '../../../../workspace/files.ts'
import { BUILDER } from './rmdir.ts'

const DEC = new TextDecoder()
const TREE: Record<string, string[]> = { '/m': ['/m/empty', '/m/locked'], '/m/empty': [] }

// A mount that removes nothing unless `removed` is given, whose stat is the
// dispatcher's: it answers what the session may see.
function files(removed?: string[]): Files {
  return answeringFiles({
    readdir: (p) => TREE[p.virtual] ?? [],
    stat: (p) => {
      if (p.virtual.startsWith('/m/locked/')) throw eacces(p.virtual)
      if (TREE[p.virtual] !== undefined)
        return new FileStat({ name: p.virtual, type: FileType.DIRECTORY })
      throw enoent(p.virtual)
    },
    ...(removed === undefined
      ? {}
      : {
          rmdir: (p) => {
            removed.push(p.virtual)
            return null
          },
        }),
  })
}

async function rmdir(vfs: Files, paths: string[]): Promise<[number, string]> {
  const result = await runWithMountGate('/', MountMode.WRITE, async () =>
    BUILDER.fn(
      {} as Accessor,
      paths.map((p) => PathSpec.fromStrPath(p)),
      [],
      { stdin: null, flags: {}, cwd: PathSpec.fromStrPath('/'), vfs },
    ),
  )
  if (result === null) throw new Error('rmdir returned no result')
  const [, res] = result
  return [res.exitCode, DEC.decode(await materialize(res.stderr))]
}

describe('rmdir builder', () => {
  it('stats its operand through the dispatcher', async () => {
    const removed: string[] = []
    expect(await rmdir(files(removed), ['/m/empty'])).toEqual([0, ''])
    expect(removed).toEqual(['/m/empty'])
  })

  it('reports an existing directory it cannot remove', async () => {
    expect(await rmdir(files(), ['/m/empty'])).toEqual([
      1,
      "rmdir: failed to remove '/m/empty': Operation not supported\n",
    ])
  })

  it('reports a refused stat in its own words and removes the rest', async () => {
    const removed: string[] = []
    expect(await rmdir(files(removed), ['/m/locked/sub', '/m/empty'])).toEqual([
      1,
      "rmdir: failed to remove '/m/locked/sub': Permission denied\n",
    ])
    expect(removed).toEqual(['/m/empty'])
  })
})
