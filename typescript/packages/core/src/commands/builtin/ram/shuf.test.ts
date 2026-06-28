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
import type { PathSpec } from '../../../types.ts'
const RAM_SHUF = RAM_COMMANDS.filter((c) => c.name === 'shuf' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runShuf(
  resource: RAMResource,
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]> = {},
  stdin: Uint8Array | null = null,
  texts: string[] = [],
): Promise<{ out: string; exitCode: number }> {
  const cmd = RAM_SHUF[0]
  if (cmd === undefined) throw new Error('shuf not registered')
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

describe('shuf', () => {
  it('-e echoes args in random order', async () => {
    const resource = new RAMResource()
    const r = await runShuf(resource, [], { e: true }, null, ['a', 'b', 'c'])
    expect(r.exitCode).toBe(0)
    const lines = r.out.trim().split('\n')
    expect(lines.length).toBe(3)
    expect([...lines].sort()).toEqual(['a', 'b', 'c'])
  })

  it('-n limits output count', async () => {
    const resource = new RAMResource()
    const r = await runShuf(resource, [], { e: true, n: '2' }, null, ['a', 'b', 'c', 'd', 'e'])
    expect(r.exitCode).toBe(0)
    const lines = r.out.trim().split('\n')
    expect(lines.length).toBe(2)
  })

  it('-r repeats items with -n count', async () => {
    const resource = new RAMResource()
    const r = await runShuf(resource, [], { r: true, e: true, n: '5' }, null, ['a', 'b', 'c'])
    expect(r.exitCode).toBe(0)
    const lines = r.out.trim().split('\n')
    expect(lines.length).toBe(5)
    for (const line of lines) {
      expect(['a', 'b', 'c']).toContain(line)
    }
  })

  it('shuffles stdin lines', async () => {
    const resource = new RAMResource()
    const r = await runShuf(resource, [], {}, ENC.encode('x\ny\nz\n'))
    expect(r.exitCode).toBe(0)
    const lines = r.out.trim().split('\n')
    expect([...lines].sort()).toEqual(['x', 'y', 'z'])
  })
})
