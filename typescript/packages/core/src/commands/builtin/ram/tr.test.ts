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
const RAM_TR = RAM_COMMANDS.filter((c) => c.name === 'tr' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runTr(
  resource: RAMResource,
  paths: PathSpec[],
  texts: string[],
  flags: Record<string, string | boolean | string[]> = {},
  stdin: Uint8Array | null = null,
): Promise<{ out: string; exitCode: number }> {
  const cmd = RAM_TR[0]
  if (cmd === undefined) throw new Error('tr not registered')
  const result = await cmd.fn(
    (resource as { accessor?: unknown }).accessor as never,
    paths,
    texts,
    {
      stdin,
      flags,
      filetypeFns: null,
      cwd: '/',
      resource,
    },
  )
  if (result === null) return { out: '', exitCode: -1 }
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  return { out: DEC.decode(buf), exitCode: ioResult.exitCode }
}

describe('tr', () => {
  it('translates vowels to uppercase', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('hello world\n'))
    const r = await runTr(resource, [PathSpec.fromStrPath('/tmp/f.txt')], ['aeiou', 'AEIOU'])
    expect(r.exitCode).toBe(0)
    expect(r.out).toBe('hEllO wOrld\n')
  })

  it('handles multiple occurrences', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('aaa bbb\n'))
    const r = await runTr(resource, [PathSpec.fromStrPath('/tmp/f.txt')], ['ab', 'AB'])
    expect(r.out).toBe('AAA BBB\n')
  })

  it('single-char translate', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('cat\n'))
    const r = await runTr(resource, [PathSpec.fromStrPath('/tmp/f.txt')], ['c', 'b'])
    expect(r.out).toBe('bat\n')
  })

  it('unchanged when no match', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('hello\n'))
    const r = await runTr(resource, [PathSpec.fromStrPath('/tmp/f.txt')], ['xyz', 'XYZ'])
    expect(r.out).toBe('hello\n')
  })

  it('-d deletes characters', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('hello\n'))
    const r = await runTr(resource, [PathSpec.fromStrPath('/tmp/f.txt')], ['l'], { d: true })
    expect(r.out).toBe('heo\n')
  })

  it('reads from stdin when no path', async () => {
    const resource = new RAMResource()
    const r = await runTr(resource, [], ['a', 'A'], {}, ENC.encode('abc\n'))
    expect(r.exitCode).toBe(0)
    expect(r.out).toBe('Abc\n')
  })

  it('supports char ranges', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('abc\n'))
    const r = await runTr(resource, [PathSpec.fromStrPath('/tmp/f.txt')], ['a-c', 'A-C'])
    expect(r.out).toBe('ABC\n')
  })

  it('missing arguments returns error', async () => {
    const resource = new RAMResource()
    const r = await runTr(resource, [], [])
    expect(r.exitCode).toBe(1)
  })
})
