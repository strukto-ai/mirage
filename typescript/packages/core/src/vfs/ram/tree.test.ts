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

import { commandIo } from '../../commands/builtin/generic_bind/adapter.ts'
import { GENERIC_COMMANDS } from '../../commands/builtin/generic_bind/factory.ts'
import { describe, expect, it } from 'vitest'
import { materialize } from '../../io/types.ts'
import { RAMVFS } from './ram.ts'
import { PathSpec } from '../../types.ts'
const RAM_TREE = GENERIC_COMMANDS.filter((c) => c.name === 'tree' && c.filetype == null)

const DEC = new TextDecoder()

async function runTree(
  vfs: RAMVFS,
  paths: PathSpec[],
  flags: Record<string, string | boolean | number | string[]> = {},
): Promise<{ lines: string[]; exitCode: number }> {
  const cmd = RAM_TREE[0]
  if (cmd === undefined) throw new Error('tree not registered')
  const result = await cmd.fn((vfs as { accessor?: unknown }).accessor as never, paths, [], {
    stdin: null,
    flags,
    io: commandIo(vfs),
    cwd: '/',
  })
  if (result === null) return { lines: [], exitCode: -1 }
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  const text = DEC.decode(buf)
  const lines = text === '' ? [] : text.trimEnd().split('\n')
  return { lines, exitCode: ioResult.exitCode }
}

describe('tree', () => {
  it('empty directory reports zero counts', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/tmp')
    const r = await runTree(vfs, [PathSpec.fromStrPath('/tmp')])
    expect(r.lines).toEqual(['/tmp', '', '0 directories, 0 files'])
    expect(r.exitCode).toBe(0)
  })
})
