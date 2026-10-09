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

import { invoke } from '../../../io/stdio.ts'
import { commandIo } from '../../../commands/builtin/generic_bind/adapter.ts'
import { RAM_COMMANDS } from './index.ts'
import { describe, expect, it } from 'vitest'
import { materialize } from '../../../io/types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { PathSpec } from '../../../types.ts'
const RAM_FIND = RAM_COMMANDS.filter((c) => c.name === 'find' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runFind(
  vfs: RAMVFS,
  paths: PathSpec[],
  flags: Record<string, string | boolean | number | string[]> = {},
  texts: string[] = [],
): Promise<{ lines: string[]; exitCode: number; runs: PathSpec[][] | null }> {
  const cmd = RAM_FIND[0]
  if (cmd === undefined) throw new Error('find not registered')
  const result = await invoke(() =>
    cmd.fn((vfs as { accessor?: unknown }).accessor as never, paths, texts, {
      stdin: null,
      flags,
      io: commandIo(vfs),
      cwd: '/',
    }),
  )
  if (result === null) return { lines: [], exitCode: -1, runs: null }
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  const text = DEC.decode(buf)
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n')
  return { lines, exitCode: ioResult.exitCode, runs: ioResult.matchedRuns }
}

describe('find -printf', () => {
  // The action layer renders -printf per row, beside the other actions,
  // so the handler hands back the rows as selected: one run per start
  // point, empty for one that is missing, the run a row's %P and %d are
  // measured from.
  it('hands the rows back unrendered, one run per start point', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/data')
    vfs.store.dirs.add('/data/sub')
    vfs.store.files.set('/data/a.txt', ENC.encode('hello\n'))
    vfs.store.files.set('/data/sub/b.txt', ENC.encode('hi\n'))
    const { lines, runs } = await runFind(
      vfs,
      [
        PathSpec.fromStrPath('/data'),
        PathSpec.fromStrPath('/nope'),
        PathSpec.fromStrPath('/data/sub'),
      ],
      {},
      ['-type', 'f', '-printf', '%f %s\\n'],
    )
    expect(lines).toEqual(['/data/a.txt', '/data/sub/b.txt', '/data/sub/b.txt'])
    expect(runs?.map((run) => run.map((p) => p.virtual))).toEqual([
      ['/data/a.txt', '/data/sub/b.txt'],
      [],
      ['/data/sub/b.txt'],
    ])
  })
})
