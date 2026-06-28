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
import { parquetWriteBuffer } from 'hyparquet-writer'
import { materialize } from '../../../../io/types.ts'
import { RAMResource } from '../../../../resource/ram/ram.ts'
import { PathSpec } from '../../../../types.ts'
import { RAM_COMMANDS } from '../index.ts'
const RAM_LS = RAM_COMMANDS.filter((c) => c.name === 'ls' && c.filetype == null)

const RAM_LS_PARQUET = RAM_COMMANDS.filter((c) => c.name === 'ls' && c.filetype === '.parquet')

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runLs(
  resource: RAMResource,
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]> = {},
): Promise<string> {
  const cmd = RAM_LS[0]
  if (cmd === undefined) throw new Error('ls not registered')
  const result = await cmd.fn(resource.accessor, paths, [], {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource,
  })
  if (result === null) return ''
  const [out] = result
  if (out === null) return ''
  const buf = out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
  return DEC.decode(buf)
}

describe('ls filetype', () => {
  it('ls without -l lists entries, no metadata enrichment', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/data')
    resource.store.files.set('/data/notes.txt', ENC.encode('hello\n'))
    resource.store.files.set('/data/test.parquet', new Uint8Array([0x50, 0x41, 0x52, 0x31]))
    const out = await runLs(resource, [PathSpec.fromStrPath('/data')])
    expect(out).toContain('notes.txt')
    expect(out).toContain('test.parquet')
    expect(out).not.toContain('rows')
  })

  it('ls -l on plain text shows name and size', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/data')
    resource.store.files.set('/data/notes.txt', ENC.encode('hello world\n'))
    const out = await runLs(resource, [PathSpec.fromStrPath('/data')], { args_l: true })
    expect(out).toContain('notes.txt')
  })

  it('ls -l on parquet via RAM_LS_PARQUET reports rows and columns', async () => {
    const resource = new RAMResource()
    const ab = parquetWriteBuffer({
      columnData: [
        { name: 'name', data: ['alice', 'bob'], type: 'STRING' },
        { name: 'score', data: [95, 80], type: 'INT32' },
      ],
    })
    resource.store.files.set('/data.parquet', new Uint8Array(ab))
    const cmd = RAM_LS_PARQUET[0]
    if (cmd === undefined) throw new Error('ls_parquet not registered')
    const result = await cmd.fn(resource.accessor, [PathSpec.fromStrPath('/data.parquet')], [], {
      stdin: null,
      flags: { args_l: true },
      filetypeFns: null,
      cwd: '/',
      resource,
    })
    if (result === null) throw new Error('no result')
    const [out] = result
    const buf =
      out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
    const text = DEC.decode(buf)
    expect(text).toContain('2 rows')
    expect(text).toContain('2 cols')
  })
})
