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
const RAM_CAT = RAM_COMMANDS.filter((c) => c.name === 'cat' && c.filetype == null)

const RAM_CAT_FEATHER = RAM_COMMANDS.filter((c) => c.name === 'cat' && c.filetype === '.feather')
const RAM_CAT_PARQUET = RAM_COMMANDS.filter((c) => c.name === 'cat' && c.filetype === '.parquet')

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runCat(resource: RAMResource, paths: PathSpec[]): Promise<string> {
  const cmd = RAM_CAT[0]
  if (cmd === undefined) throw new Error('cat not registered')
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

async function runCatParquet(resource: RAMResource, paths: PathSpec[]): Promise<string> {
  const cmd = RAM_CAT_PARQUET[0]
  if (cmd === undefined) throw new Error('cat_parquet not registered')
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

function makeParquet(): Uint8Array {
  const ab = parquetWriteBuffer({
    columnData: [
      { name: 'name', data: ['alice', 'bob'], type: 'STRING' },
      { name: 'score', data: [95, 80], type: 'INT32' },
    ],
  })
  return new Uint8Array(ab)
}

describe('cat filetype dispatch', () => {
  it('cat on plain text returns bytes unchanged', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/test.txt', ENC.encode('hello world'))
    const out = await runCat(resource, [PathSpec.fromStrPath('/test.txt')])
    expect(out).toBe('hello world')
  })

  it('cat on parquet shows schema + preview rows', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/data.parquet', makeParquet())
    const out = await runCatParquet(resource, [PathSpec.fromStrPath('/data.parquet')])
    expect(out).toContain('## Schema')
    expect(out).toContain('name:')
    expect(out).toContain('score:')
    expect(out).toContain('alice')
    expect(out).toContain('bob')
  })

  it('cat_parquet dispatch is registered with filetype=.parquet', () => {
    const cmd = RAM_CAT_PARQUET[0]
    expect(cmd?.filetype).toBe('.parquet')
  })

  it.todo('cat on orc shows metadata (ORC filetype not ported to TS)')

  it('cat on feather shows preview via RAM_CAT_FEATHER', async () => {
    const resource = new RAMResource()
    resource.store.files.set(
      '/data.feather',
      featherWriteBuffer({ name: ['alice', 'bob'], score: [95, 80] }),
    )
    const cmd = RAM_CAT_FEATHER[0]
    if (cmd === undefined) throw new Error('cat_feather not registered')
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
    expect(text).toContain('## Schema')
    expect(text).toContain('name')
    expect(text).toContain('score')
    expect(text).toContain('alice')
    expect(text).toContain('bob')
  })
})
