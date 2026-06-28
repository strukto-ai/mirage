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
import { featherWriteBuffer } from '../../../../core/filetype/feather_writer.ts'
import { materialize } from '../../../../io/types.ts'
import { RAMResource } from '../../../../resource/ram/ram.ts'
import { PathSpec } from '../../../../types.ts'
import { RAM_COMMANDS } from '../index.ts'
const RAM_FILE = RAM_COMMANDS.filter((c) => c.name === 'file' && c.filetype == null)

const RAM_FILE_FEATHER = RAM_COMMANDS.filter((c) => c.name === 'file' && c.filetype === '.feather')
const RAM_FILE_PARQUET = RAM_COMMANDS.filter((c) => c.name === 'file' && c.filetype === '.parquet')

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runFile(resource: RAMResource, paths: PathSpec[]): Promise<string> {
  const cmd = RAM_FILE[0]
  if (cmd === undefined) throw new Error('file not registered')
  const result = await cmd.fn(resource.accessor, paths, [], {
    stdin: null,
    flags: {},
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

describe('file filetype detection', () => {
  it('detects plain text as text', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/notes.txt', ENC.encode('hello world\n'))
    const out = await runFile(resource, [PathSpec.fromStrPath('/notes.txt')])
    expect(out.toLowerCase()).toContain('text')
  })

  it('detects PNG magic bytes as image/png', async () => {
    const resource = new RAMResource()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    resource.store.files.set('/img.png', png)
    const out = await runFile(resource, [PathSpec.fromStrPath('/img.png')])
    expect(out).toContain('image/png')
  })

  it('detects gzip magic bytes', async () => {
    const resource = new RAMResource()
    const gz = new Uint8Array([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0])
    resource.store.files.set('/a.gz', gz)
    const out = await runFile(resource, [PathSpec.fromStrPath('/a.gz')])
    expect(out).toContain('gzip')
  })

  it('file on parquet reports row/column counts via RAM_FILE_PARQUET', async () => {
    const resource = new RAMResource()
    const ab = parquetWriteBuffer({
      columnData: [
        { name: 'name', data: ['alice', 'bob'], type: 'STRING' },
        { name: 'score', data: [95, 80], type: 'INT32' },
      ],
    })
    resource.store.files.set('/data.parquet', new Uint8Array(ab))
    const cmd = RAM_FILE_PARQUET[0]
    if (cmd === undefined) throw new Error('file_parquet not registered')
    const result = await cmd.fn(resource.accessor, [PathSpec.fromStrPath('/data.parquet')], [], {
      stdin: null,
      flags: {},
      filetypeFns: null,
      cwd: '/',
      resource,
    })
    if (result === null) throw new Error('no result')
    const [out] = result
    const buf =
      out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
    const text = DEC.decode(buf)
    expect(text).toContain('parquet')
    expect(text).toContain('2 rows')
    expect(text).toContain('name')
    expect(text).toContain('score')
  })

  it.todo('detects orc metadata (ORC filetype not ported to TS)')

  it('file on feather reports row/column counts via RAM_FILE_FEATHER', async () => {
    const resource = new RAMResource()
    resource.store.files.set(
      '/data.feather',
      featherWriteBuffer({ name: ['alice', 'bob'], score: [95, 80] }),
    )
    const cmd = RAM_FILE_FEATHER[0]
    if (cmd === undefined) throw new Error('file_feather not registered')
    const result = await cmd.fn(resource.accessor, [PathSpec.fromStrPath('/data.feather')], [], {
      stdin: null,
      flags: {},
      filetypeFns: null,
      cwd: '/',
      resource,
    })
    if (result === null) throw new Error('no result')
    const [out] = result
    const buf =
      out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
    const text = DEC.decode(buf)
    expect(text).toContain('feather')
    expect(text).toContain('2 rows')
    expect(text).toContain('name')
    expect(text).toContain('score')
  })
})
