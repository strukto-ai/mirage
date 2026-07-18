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
const RAM_SORT = RAM_COMMANDS.filter((c) => c.name === 'sort' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runSort(
  resource: RAMResource,
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]> = {},
  stdin: Uint8Array | null = null,
): Promise<{ lines: string[]; exitCode: number }> {
  const cmd = RAM_SORT[0]
  if (cmd === undefined) throw new Error('sort not registered')
  const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, paths, [], {
    stdin,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource,
  })
  if (result === null) return { lines: [], exitCode: -1 }
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
  return { lines, exitCode: ioResult.exitCode }
}

describe('sort', () => {
  it('default alphabetical sort', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('banana\napple\ncherry'))
    const r = await runSort(resource, [PathSpec.fromStrPath('/tmp/f.txt')])
    expect(r.exitCode).toBe(0)
    expect(r.lines).toEqual(['apple', 'banana', 'cherry'])
  })

  it('already sorted stays in order', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('a\nb\nc'))
    const r = await runSort(resource, [PathSpec.fromStrPath('/tmp/f.txt')])
    expect(r.lines).toEqual(['a', 'b', 'c'])
  })

  it('-r reverses sort order', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('banana\napple\ncherry'))
    const r = await runSort(resource, [PathSpec.fromStrPath('/tmp/f.txt')], { r: true })
    expect(r.lines).toEqual(['cherry', 'banana', 'apple'])
  })

  it('-n numeric sort', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('10\n2\n30\n1'))
    const r = await runSort(resource, [PathSpec.fromStrPath('/tmp/f.txt')], { n: true })
    expect(r.lines).toEqual(['1', '2', '10', '30'])
  })

  it('-u deduplicates', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('banana\napple\nbanana\napple\ncherry'))
    const r = await runSort(resource, [PathSpec.fromStrPath('/tmp/f.txt')], { u: true })
    expect(r.lines).toEqual(['apple', 'banana', 'cherry'])
  })

  it('-f ignores case', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('Banana\napple\nCherry'))
    const r = await runSort(resource, [PathSpec.fromStrPath('/tmp/f.txt')], { f: true })
    expect(r.lines).toEqual(['apple', 'Banana', 'Cherry'])
  })

  it('-k numeric key field', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('a 10\nb 2\nc 30'))
    const r = await runSort(resource, [PathSpec.fromStrPath('/tmp/f.txt')], {
      k: '2',
      n: true,
    })
    expect(r.lines).toEqual(['b 2', 'a 10', 'c 30'])
  })

  it('-t field separator with -k', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('a:10\nb:2\nc:30'))
    const r = await runSort(resource, [PathSpec.fromStrPath('/tmp/f.txt')], {
      t: ':',
      k: '2',
      n: true,
    })
    expect(r.lines).toEqual(['b:2', 'a:10', 'c:30'])
  })

  it('-n -r combined', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('10\n2\n30\n1'))
    const r = await runSort(resource, [PathSpec.fromStrPath('/tmp/f.txt')], {
      n: true,
      r: true,
    })
    expect(r.lines).toEqual(['30', '10', '2', '1'])
  })

  it('missing stdin and no path uses empty standard input', async () => {
    const resource = new RAMResource()
    const r = await runSort(resource, [])
    expect(r.exitCode).toBe(0)
    expect(r.lines).toEqual([])
  })
})
