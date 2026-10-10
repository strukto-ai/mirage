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
import { GENERIC_COMMANDS } from '../generic_bind/factory.ts'
import { describe, expect, it } from 'vitest'
import { materialize } from '../../../io/types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { PathSpec } from '../../../types.ts'
const RAM_LS = GENERIC_COMMANDS.filter((c) => c.name === 'ls' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runLs(
  vfs: RAMVFS,
  paths: PathSpec[],
  flags: Record<string, string | boolean | number | string[]> = {},
): Promise<string> {
  const cmd = RAM_LS[0]
  if (cmd === undefined) throw new Error('ls not registered')
  const result = await cmd.fn(vfs.accessor, paths, [], {
    stdin: null,
    flags,
    io: commandIo(vfs),
    cwd: '/',
  })
  if (result === null) return ''
  const [out] = result
  if (out === null) return ''
  const buf = out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
  return DEC.decode(buf)
}

function seed(vfs: RAMVFS, dirs: string[], files: Record<string, string>): void {
  for (const d of dirs) vfs.store.dirs.add(d)
  for (const [p, content] of Object.entries(files)) {
    vfs.store.files.set(p, ENC.encode(content))
  }
}

describe('ls', () => {
  it('-a with -r reverses all entries', async () => {
    const vfs = new RAMVFS()
    seed(vfs, ['/tmp'], {
      '/tmp/.z_hidden': 'z',
      '/tmp/a.txt': 'a',
      '/tmp/m.txt': 'm',
    })
    const out = await runLs(vfs, [PathSpec.fromStrPath('/tmp')], { all: true, reverse: true })
    expect(out.trimEnd().split('\n')).toEqual(['m.txt', 'a.txt', '.z_hidden', '..', '.'])
  })
})
