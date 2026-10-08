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
const RAM_CAT = RAM_COMMANDS.filter((c) => c.name === 'cat' && c.filetype == null)

describe('cat', () => {
  it('full byte range (256 bytes)', async () => {
    const vfs = new RAMVFS()
    const data = new Uint8Array(256)
    for (let i = 0; i < 256; i++) data[i] = i
    vfs.store.files.set('/tmp/f.bin', data)
    const cmd = RAM_CAT[0]
    if (cmd === undefined) throw new Error('cat not registered')
    const result = await cmd.fn(vfs.accessor, [PathSpec.fromStrPath('/tmp/f.bin')], [], {
      stdin: null,
      flags: {},
      io: commandIo(vfs),
      cwd: '/',
    })
    if (result === null) throw new Error('null')
    const [out] = result
    if (out === null) throw new Error('null out')
    const buf =
      out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
    expect(buf.byteLength).toBe(256)
    for (let i = 0; i < 256; i++) expect(buf[i]).toBe(i)
  })
})
