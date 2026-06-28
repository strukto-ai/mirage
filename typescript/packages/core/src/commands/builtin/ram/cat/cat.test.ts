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

import { RAM_COMMANDS } from '../index.ts'
import { describe, expect, it } from 'vitest'
import { materialize } from '../../../../io/types.ts'
import { RAMResource } from '../../../../resource/ram/ram.ts'
import { PathSpec } from '../../../../types.ts'
const RAM_CAT = RAM_COMMANDS.filter((c) => c.name === 'cat' && c.filetype == null)

const DEC = new TextDecoder()

async function runCat(
  resource: RAMResource,
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]> = {},
): Promise<string> {
  const cmd = RAM_CAT[0]
  if (cmd === undefined) throw new Error('cat not registered')
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

describe('cat', () => {
  it('returns bytes for existing file', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', new TextEncoder().encode('hello world'))
    expect(await runCat(resource, [PathSpec.fromStrPath('/tmp/f.txt')])).toBe('hello world')
  })

  it('empty file', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', new Uint8Array())
    expect(await runCat(resource, [PathSpec.fromStrPath('/tmp/f.txt')])).toBe('')
  })

  it('full byte range (256 bytes)', async () => {
    const resource = new RAMResource()
    const data = new Uint8Array(256)
    for (let i = 0; i < 256; i++) data[i] = i
    resource.store.files.set('/tmp/f.bin', data)
    const cmd = RAM_CAT[0]
    if (cmd === undefined) throw new Error('cat not registered')
    const result = await cmd.fn(resource.accessor, [PathSpec.fromStrPath('/tmp/f.bin')], [], {
      stdin: null,
      flags: {},
      filetypeFns: null,
      cwd: '/',
      resource,
    })
    if (result === null) throw new Error('null')
    const [out] = result
    if (out === null) throw new Error('null out')
    const buf =
      out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
    expect(buf.byteLength).toBe(256)
    for (let i = 0; i < 256; i++) expect(buf[i]).toBe(i)
  })

  it('multiline content', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', new TextEncoder().encode('line1\nline2\nline3\n'))
    expect(await runCat(resource, [PathSpec.fromStrPath('/tmp/f.txt')])).toBe(
      'line1\nline2\nline3\n',
    )
  })
})
