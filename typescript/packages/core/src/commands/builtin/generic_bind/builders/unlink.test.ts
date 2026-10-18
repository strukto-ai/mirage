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
import { BUILDER } from './unlink.ts'

const DEC = new TextDecoder()

// A mount that removes nothing unless `removed` is given, whose stat is the
// dispatcher's: it answers what the session may see.
function files(removed?: string[]): Files {
  return answeringFiles({
    readdir: (p) => (p.virtual === '/m' ? ['/m/a.txt', '/m/locked'] : []),
    stat: (p) => {
      if (p.virtual.startsWith('/m/locked/')) throw eacces(p.virtual)
      if (p.virtual === '/m/a.txt') return new FileStat({ name: p.virtual, type: FileType.FILE })
      throw enoent(p.virtual)
    },
    ...(removed === undefined
      ? {}
      : {
          unlink: (p) => {
            removed.push(p.virtual)
            return null
          },
        }),
  })
}

async function unlink(vfs: Files, path: string): Promise<[number, string]> {
  const result = await runWithMountGate('/', MountMode.WRITE, async () =>
    BUILDER.fn({} as Accessor, [PathSpec.fromStrPath(path)], [], {
      stdin: null,
      flags: {},
      cwd: PathSpec.fromStrPath('/'),
      vfs,
    }),
  )
  if (result === null) throw new Error('unlink returned no result')
  const [, res] = result
  return [res.exitCode, DEC.decode(await materialize(res.stderr))]
}

describe('unlink builder', () => {
  it('stats its operand through the dispatcher', async () => {
    const removed: string[] = []
    expect(await unlink(files(removed), '/m/a.txt')).toEqual([0, ''])
    expect(removed).toEqual(['/m/a.txt'])
  })

  it('reports an existing file it cannot remove', async () => {
    expect(await unlink(files(), '/m/a.txt')).toEqual([
      1,
      "unlink: cannot unlink '/m/a.txt': Operation not supported\n",
    ])
  })

  it('reports a refused stat in its own words', async () => {
    expect(await unlink(files(), '/m/locked/f.txt')).toEqual([
      1,
      "unlink: cannot unlink '/m/locked/f.txt': Permission denied\n",
    ])
  })
})
