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
const RAM_NL = RAM_COMMANDS.filter((c) => c.name === 'nl' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runNl(
  resource: RAMResource,
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]> = {},
  stdin: Uint8Array | null = null,
): Promise<{ out: string; exitCode: number }> {
  const cmd = RAM_NL[0]
  if (cmd === undefined) throw new Error('nl not registered')
  const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, paths, [], {
    stdin,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource,
  })
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

describe('nl', () => {
  it('numbers non-empty lines by default', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('hello\n\nworld\n'))
    const r = await runNl(resource, [PathSpec.fromStrPath('/tmp/f.txt')])
    expect(r.exitCode).toBe(0)
    const lines = r.out.split('\n')
    expect(lines[0]).toContain('1')
    expect(lines[0]).toContain('hello')
    expect(lines[1]?.trim()).toBe('')
    expect(lines[2]).toContain('2')
    expect(lines[2]).toContain('world')
  })

  it('-b a numbers all lines including empty', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('hello\n\nworld\n'))
    const r = await runNl(resource, [PathSpec.fromStrPath('/tmp/f.txt')], { b: 'a' })
    const lines = r.out.split('\n')
    expect(lines[0]).toContain('1')
    expect(lines[1]).toContain('2')
    expect(lines[2]).toContain('3')
  })

  it('-b n emits no line numbers', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('hello\nworld\n'))
    const r = await runNl(resource, [PathSpec.fromStrPath('/tmp/f.txt')], { b: 'n' })
    const lines = r.out.split('\n')
    for (const line of lines) {
      if (line === '') continue
      expect(line.trimStart().startsWith('hello') || line.trimStart().startsWith('world')).toBe(
        true,
      )
    }
  })

  it('-w width and -s separator', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('hello\n'))
    const r = await runNl(resource, [PathSpec.fromStrPath('/tmp/f.txt')], {
      w: '3',
      s: ':',
    })
    expect(r.out).toContain('  1:hello')
  })

  it('-v start and -i increment', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/f.txt', ENC.encode('a\nb\nc\n'))
    const r = await runNl(resource, [PathSpec.fromStrPath('/tmp/f.txt')], {
      v: '10',
      i: '5',
    })
    const lines = r.out.split('\n')
    expect(lines[0]).toContain('10')
    expect(lines[1]).toContain('15')
    expect(lines[2]).toContain('20')
  })

  it('reads from stdin when no path', async () => {
    const resource = new RAMResource()
    const r = await runNl(resource, [], {}, ENC.encode('x\ny\n'))
    expect(r.exitCode).toBe(0)
    const lines = r.out.split('\n')
    expect(lines[0]).toContain('1')
    expect(lines[0]).toContain('x')
    expect(lines[1]).toContain('2')
    expect(lines[1]).toContain('y')
  })

  it('missing stdin with no path returns error', async () => {
    const resource = new RAMResource()
    const cmd = RAM_NL[0]
    if (cmd === undefined) throw new Error('nl not registered')
    const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, [], [], {
      stdin: null,
      flags: {},
      filetypeFns: null,
      cwd: '/',
      resource,
    })
    if (result === null) throw new Error('result null')
    const [, ioResult] = result
    expect(ioResult.exitCode).toBe(1)
  })
})
