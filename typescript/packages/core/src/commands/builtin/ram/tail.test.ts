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

import { commandIo } from '../../../commands/builtin/generic_bind/adapter.ts'
import { RAM_COMMANDS } from './index.ts'
import { describe, expect, it } from 'vitest'
import { materialize } from '../../../io/types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { PathSpec } from '../../../types.ts'
const RAM_TAIL = RAM_COMMANDS.filter((c) => c.name === 'tail' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

const TWENTY_LINES = Array.from({ length: 20 }, (_, i) => `line${String(i + 1)}`).join('\n')

async function runTail(
  vfs: RAMVFS,
  paths: PathSpec[],
  flags: Record<string, string | boolean | number | string[]> = {},
): Promise<string> {
  const cmd = RAM_TAIL[0]
  if (cmd === undefined) throw new Error('tail not registered')
  const result = await cmd.fn(vfs.accessor, paths, [], {
    stdin: null,
    flags,
    filetypeFns: null,
    io: commandIo(vfs),
    cwd: '/',
  })
  if (result === null) return ''
  const [out] = result
  if (out === null) return ''
  const buf = out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
  return DEC.decode(buf)
}

describe('tail', () => {
  it('returns last 10 lines by default', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/tmp/f.txt', ENC.encode(TWENTY_LINES))
    const expected = Array.from({ length: 10 }, (_, i) => `line${String(i + 11)}`).join('\n')
    expect(await runTail(vfs, [PathSpec.fromStrPath('/tmp/f.txt')])).toBe(expected)
  })
})
