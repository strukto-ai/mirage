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
const RAM_WC = RAM_COMMANDS.filter((c) => c.name === 'wc' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runWc(
  resource: RAMResource,
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]> = {},
): Promise<string> {
  const cmd = RAM_WC[0]
  if (cmd === undefined) throw new Error('wc not registered')
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

describe('wc', () => {
  it('default shows lines, words, bytes, path', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('hello world\nfoo bar\n'))
    expect(await runWc(resource, [PathSpec.fromStrPath('/tmp/f.txt')])).toBe(
      ' 2  4 20 /tmp/f.txt\n',
    )
  })

  it('empty file', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', new Uint8Array())
    expect(await runWc(resource, [PathSpec.fromStrPath('/tmp/f.txt')])).toBe('0 0 0 /tmp/f.txt\n')
  })

  it('-l counts lines with trailing newline', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('a\nb\nc\n'))
    expect(await runWc(resource, [PathSpec.fromStrPath('/tmp/f.txt')], { args_l: true })).toBe(
      '3 /tmp/f.txt\n',
    )
  })

  it('-l counts lines without trailing newline', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('a\nb\nc'))
    expect(await runWc(resource, [PathSpec.fromStrPath('/tmp/f.txt')], { args_l: true })).toBe(
      '2 /tmp/f.txt\n',
    )
  })

  it('-w single line', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('one two three'))
    expect(await runWc(resource, [PathSpec.fromStrPath('/tmp/f.txt')], { w: true })).toBe(
      '3 /tmp/f.txt\n',
    )
  })

  it('-w multiline', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('one two\nthree four five\nsix\n'))
    expect(await runWc(resource, [PathSpec.fromStrPath('/tmp/f.txt')], { w: true })).toBe(
      '6 /tmp/f.txt\n',
    )
  })

  it('-c counts bytes (ascii)', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('hello'))
    expect(await runWc(resource, [PathSpec.fromStrPath('/tmp/f.txt')], { c: true })).toBe(
      '5 /tmp/f.txt\n',
    )
  })

  it('-c counts bytes (multibyte)', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('caf\u00e9'))
    expect(await runWc(resource, [PathSpec.fromStrPath('/tmp/f.txt')], { c: true })).toBe(
      '5 /tmp/f.txt\n',
    )
  })

  it('-m counts chars (ascii)', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('hello'))
    expect(await runWc(resource, [PathSpec.fromStrPath('/tmp/f.txt')], { m: true })).toBe(
      '5 /tmp/f.txt\n',
    )
  })

  it('-m counts chars (multibyte utf8)', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('caf\u00e9'))
    expect(await runWc(resource, [PathSpec.fromStrPath('/tmp/f.txt')], { m: true })).toBe(
      '4 /tmp/f.txt\n',
    )
  })
})
