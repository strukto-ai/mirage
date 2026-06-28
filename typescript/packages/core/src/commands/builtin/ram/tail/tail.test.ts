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
const RAM_TAIL = RAM_COMMANDS.filter((c) => c.name === 'tail' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

const TWENTY_LINES = Array.from({ length: 20 }, (_, i) => `line${String(i + 1)}`).join('\n')

async function runTail(
  resource: RAMResource,
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]> = {},
): Promise<string> {
  const cmd = RAM_TAIL[0]
  if (cmd === undefined) throw new Error('tail not registered')
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

describe('tail', () => {
  it('returns last 10 lines by default', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode(TWENTY_LINES))
    const expected = Array.from({ length: 10 }, (_, i) => `line${String(i + 11)}`).join('\n')
    expect(await runTail(resource, [PathSpec.fromStrPath('/tmp/f.txt')])).toBe(expected)
  })

  it('-n 3 returns last 3 lines', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode(TWENTY_LINES))
    expect(await runTail(resource, [PathSpec.fromStrPath('/tmp/f.txt')], { n: '3' })).toBe(
      'line18\nline19\nline20',
    )
  })

  it('-n 1 returns last line', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode(TWENTY_LINES))
    expect(await runTail(resource, [PathSpec.fromStrPath('/tmp/f.txt')], { n: '1' })).toBe('line20')
  })

  it('-n larger than file returns all', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('a\nb\nc'))
    expect(await runTail(resource, [PathSpec.fromStrPath('/tmp/f.txt')], { n: '100' })).toBe(
      'a\nb\nc',
    )
  })

  it('-c returns specific byte count', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('abcdefghij'))
    expect(await runTail(resource, [PathSpec.fromStrPath('/tmp/f.txt')], { c: '5' })).toBe('fghij')
  })

  it('-c larger than file returns all bytes', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('abc'))
    expect(await runTail(resource, [PathSpec.fromStrPath('/tmp/f.txt')], { c: '100' })).toBe('abc')
  })

  it('-c 0 returns empty', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('abc'))
    expect(await runTail(resource, [PathSpec.fromStrPath('/tmp/f.txt')], { c: '0' })).toBe('')
  })

  it('empty file', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', new Uint8Array())
    expect(await runTail(resource, [PathSpec.fromStrPath('/tmp/f.txt')])).toBe('')
  })

  it('single line without newline', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('hello'))
    expect(await runTail(resource, [PathSpec.fromStrPath('/tmp/f.txt')])).toBe('hello')
  })
})
