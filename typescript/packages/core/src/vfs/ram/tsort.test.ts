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

import { PathSpec } from '../../types.ts'
import { onMount } from '../../test-utils.ts'
import { GENERIC_COMMANDS } from '../../commands/builtin/generic_bind/factory.ts'
import { describe, expect, it } from 'vitest'
import { materialize } from '../../io/types.ts'
import { RAMVFS } from './ram.ts'
const RAM_TSORT = GENERIC_COMMANDS.filter((c) => c.name === 'tsort' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runTsort(
  stdin: Uint8Array | null,
): Promise<{ out: string; err: string; exitCode: number }> {
  const vfs = new RAMVFS()
  const cmd = RAM_TSORT[0]
  if (cmd === undefined) throw new Error('tsort not registered')
  const result = await onMount(vfs, (files) =>
    cmd.fn((vfs as { accessor?: unknown }).accessor as never, [], [], {
      stdin,
      flags: {},
      vfs: files,
      cwd: PathSpec.fromStrPath('/'),
    }),
  )
  if (result === null) return { out: '', err: '', exitCode: -1 }
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  const err = ioResult.stderr === null ? new Uint8Array() : await materialize(ioResult.stderr)
  return { out: DEC.decode(buf), err: DEC.decode(err), exitCode: ioResult.exitCode }
}

function loops(...members: string[][]): string {
  return members
    .map((loop) => `tsort: -: input contains a loop:\n${loop.map((m) => `tsort: ${m}\n`).join('')}`)
    .join('')
}

describe('tsort', () => {
  it('simple topological sort', async () => {
    const r = await runTsort(ENC.encode('a b\nb c\n'))
    expect(r.exitCode).toBe(0)
    expect(r.out.trim()).toBe('a\nb\nc')
  })

  it('detects cycle and returns exit code 1', async () => {
    const r = await runTsort(ENC.encode('a b\nb a\n'))
    expect(r.exitCode).toBe(1)
  })

  it('cuts loops until a name is free', async () => {
    // GNU 9.7: each cut drops the pair that closed the loop, and the loops
    // go on until one cut frees a name.
    const r = await runTsort(ENC.encode('h f\nb f\ng b\nf h\nh b\nh g\nh h\n'))
    expect([r.out, r.exitCode]).toEqual(['b\nf\nh\ng\n', 1])
    expect(r.err).toBe(loops(['f', 'h'], ['b', 'f', 'h', 'g'], ['b', 'f', 'h']))
  })

  it('repeats a loop held by a repeated pair', async () => {
    const r = await runTsort(ENC.encode('d f\nb c\nc a\nd f\nf d\nc f\nd c\n'))
    expect([r.out, r.exitCode]).toEqual(['b\nf\nd\nc\na\n', 1])
    expect(r.err).toBe(loops(['f', 'd', 'c'], ['f', 'd'], ['f', 'd']))
  })

  it('breaks one loop per component, smallest first', async () => {
    const r = await runTsort(ENC.encode('q r\nr q\na b\nb a\nm n\n'))
    expect([r.out, r.exitCode]).toEqual(['m\nn\na\nb\nq\nr\n', 1])
    expect(r.err).toBe(loops(['a', 'b'], ['q', 'r']))
  })

  it('walks back to the next name after it', async () => {
    // The step back from c can take a or g; GNU takes g, the next name
    // after c, so the loop is a g c rather than a c.
    const r = await runTsort(ENC.encode('a g a c\nc a h d g c d g\n'))
    expect([r.out, r.exitCode]).toEqual(['h\nd\na\ng\nc\n', 1])
    expect(r.err).toBe(loops(['a', 'g', 'c']))
  })

  it('orders the free names by bytes', async () => {
    // GNU 9.7: a m x go first, in byte order; c follows them, d waits on c.
    const r = await runTsort(ENC.encode('m n\nc d\nx y\na d\na c\n'))
    expect([r.out, r.exitCode]).toEqual(['a\nm\nx\nc\nn\ny\nd\n', 0])
  })
})
