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
import { materialize } from '../../../io/types.ts'
import { RAMResource } from '../../../resource/ram/ram.ts'
import { PathSpec } from '../../../types.ts'
const RAM_UNIQ = RAM_COMMANDS.filter((c) => c.name === 'uniq' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runUniq(
  resource: RAMResource,
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]> = {},
  stdin: Uint8Array | null = null,
): Promise<{ lines: string[]; exitCode: number; stderr: string }> {
  const cmd = RAM_UNIQ[0]
  if (cmd === undefined) throw new Error('uniq not registered')
  const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, paths, [], {
    stdin,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource,
  })
  if (result === null) return { lines: [], exitCode: -1, stderr: '' }
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  const text = DEC.decode(buf)
  const stripped = text.endsWith('\n') ? text.slice(0, -1) : text
  const lines = stripped === '' ? [] : stripped.split('\n')
  const stderr = DEC.decode(await materialize(ioResult.stderr))
  return { lines, exitCode: ioResult.exitCode, stderr }
}

describe('uniq', () => {
  it('removes consecutive duplicate lines', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('aaa\naaa\nbbb\nccc\nccc'))
    const r = await runUniq(resource, [PathSpec.fromStrPath('/tmp/f.txt')])
    expect(r.exitCode).toBe(0)
    expect(r.lines).toEqual(['aaa', 'bbb', 'ccc'])
  })

  it('keeps non-consecutive duplicates', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('aaa\nbbb\naaa'))
    const r = await runUniq(resource, [PathSpec.fromStrPath('/tmp/f.txt')])
    expect(r.lines).toEqual(['aaa', 'bbb', 'aaa'])
  })

  it('-c prefixes each line with count', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('aaa\naaa\nbbb\nccc\nccc\nccc'))
    const r = await runUniq(resource, [PathSpec.fromStrPath('/tmp/f.txt')], { c: true })
    expect(r.lines).toEqual(['      2 aaa', '      1 bbb', '      3 ccc'])
  })

  it('-d shows only duplicated lines', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('aaa\naaa\nbbb\nccc\nccc'))
    const r = await runUniq(resource, [PathSpec.fromStrPath('/tmp/f.txt')], { d: true })
    expect(r.lines).toEqual(['aaa', 'ccc'])
  })

  it('-d with no duplicates produces empty output', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('aaa\nbbb\nccc'))
    const r = await runUniq(resource, [PathSpec.fromStrPath('/tmp/f.txt')], { d: true })
    expect(r.lines).toEqual([])
  })

  it('-u shows only unique lines', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('aaa\naaa\nbbb\nccc\nccc'))
    const r = await runUniq(resource, [PathSpec.fromStrPath('/tmp/f.txt')], { u: true })
    expect(r.lines).toEqual(['bbb'])
  })

  it('-c -d combined', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('aaa\naaa\nbbb\nccc\nccc\nccc'))
    const r = await runUniq(resource, [PathSpec.fromStrPath('/tmp/f.txt')], {
      c: true,
      d: true,
    })
    expect(r.lines).toEqual(['      2 aaa', '      3 ccc'])
  })

  it('empty file produces empty output', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', new Uint8Array())
    const r = await runUniq(resource, [PathSpec.fromStrPath('/tmp/f.txt')])
    expect(r.lines).toEqual([])
  })

  it('single line is passed through', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('hello'))
    const r = await runUniq(resource, [PathSpec.fromStrPath('/tmp/f.txt')])
    expect(r.lines).toEqual(['hello'])
  })

  it('reads from stdin when no path', async () => {
    const resource = new RAMResource()
    const r = await runUniq(resource, [], {}, ENC.encode('a\na\nb\n'))
    expect(r.lines).toEqual(['a', 'b'])
  })

  it('missing stdin and no path uses empty standard input', async () => {
    const resource = new RAMResource()
    const r = await runUniq(resource, [])
    expect(r.exitCode).toBe(0)
    expect(r.lines).toEqual([])
  })

  it('rejects trailing text in numeric options', async () => {
    const resource = new RAMResource()
    const r = await runUniq(resource, [], { f: '2junk' })
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toBe("uniq: invalid count: '2junk'\n")
  })
})
