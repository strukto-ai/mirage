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
const RAM_XXD = RAM_COMMANDS.filter((c) => c.name === 'xxd' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runXxd(
  resource: RAMResource,
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]> = {},
  stdin: Uint8Array | null = null,
): Promise<{ out: string; outBytes: Uint8Array; exitCode: number }> {
  const cmd = RAM_XXD[0]
  if (cmd === undefined) throw new Error('xxd not registered')
  const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, paths, [], {
    stdin,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource,
  })
  if (result === null) return { out: '', outBytes: new Uint8Array(), exitCode: -1 }
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  return { out: DEC.decode(buf), outBytes: buf, exitCode: ioResult.exitCode }
}

describe('xxd', () => {
  it('-p plain hex', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/f.txt', ENC.encode('AB'))
    const r = await runXxd(resource, [PathSpec.fromStrPath('/f.txt')], { p: true })
    expect(r.exitCode).toBe(0)
    expect(r.out.trim()).toBe('4142')
  })

  it('-r -p reverse hex from stdin', async () => {
    const resource = new RAMResource()
    const r = await runXxd(resource, [], { r: true, p: true }, ENC.encode('4142'))
    expect(r.exitCode).toBe(0)
    expect(DEC.decode(r.outBytes)).toBe('AB')
  })

  it('-u uppercase', async () => {
    const resource = new RAMResource()
    const r = await runXxd(resource, [], { u: true }, new Uint8Array([0xab, 0xcd]))
    expect(r.exitCode).toBe(0)
    const text = r.out
    expect(text.includes('AB') || text.includes('CD')).toBe(true)
  })
})
