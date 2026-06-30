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

import { RAM_COMMANDS } from './index.ts'
import { describe, expect, it } from 'vitest'
import { parquetWriteBuffer } from 'hyparquet-writer'
import { grep as parquetGrep } from '../../../core/filetype/parquet.ts'
import { materialize } from '../../../io/types.ts'
import { RAMResource } from '../../../resource/ram/ram.ts'
import { PathSpec } from '../../../types.ts'
const RAM_RG = RAM_COMMANDS.filter((c) => c.name === 'rg' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runRg(
  resource: RAMResource,
  pattern: string,
  paths: PathSpec[],
): Promise<{ text: string; exitCode: number }> {
  const cmd = RAM_RG[0]
  if (cmd === undefined) throw new Error('rg not registered')
  const result = await cmd.fn(resource.accessor, paths, [pattern], {
    stdin: null,
    flags: {},
    filetypeFns: null,
    cwd: '/',
    resource,
  })
  if (result === null) return { text: '', exitCode: 0 }
  const [out, io] = result
  if (out === null) return { text: '', exitCode: io.exitCode }
  const buf = out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
  return { text: DEC.decode(buf), exitCode: io.exitCode }
}

describe('rg filetype', () => {
  it('rg finds in plain text file', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/data')
    resource.store.files.set('/data/notes.txt', ENC.encode('alice likes cats\nbob likes dogs\n'))
    const { text } = await runRg(resource, 'alice', [PathSpec.fromStrPath('/data/notes.txt')])
    expect(text).toContain('alice')
  })

  it('rg on plain file with no match returns exitCode 1', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/notes.txt', ENC.encode('alice\nbob\n'))
    const { text, exitCode } = await runRg(resource, 'nonexistent', [
      PathSpec.fromStrPath('/notes.txt'),
    ])
    expect(text.trim()).toBe('')
    expect(exitCode).toBe(1)
  })

  it('rg over a directory walks files and returns matches', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/data')
    resource.store.dirs.add('/data/sub')
    resource.store.files.set('/data/a.txt', ENC.encode('alice\nbob\n'))
    resource.store.files.set('/data/sub/b.txt', ENC.encode('carol\nalice likes tea\n'))
    const { text, exitCode } = await runRg(resource, 'alice', [PathSpec.fromStrPath('/data')])
    expect(exitCode).toBe(0)
    expect(text).toContain('alice')
    expect(text).toContain('b.txt')
  })

  it('parquet filetype grep helper matches pattern against rows', async () => {
    const ab = parquetWriteBuffer({
      columnData: [{ name: 'name', data: ['alice', 'bob'], type: 'STRING' }],
    })
    const out = await parquetGrep(new Uint8Array(ab), 'alice')
    expect(DEC.decode(out)).toContain('alice')
  })
})
