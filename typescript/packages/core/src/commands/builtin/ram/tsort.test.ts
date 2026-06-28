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
const RAM_TSORT = RAM_COMMANDS.filter((c) => c.name === 'tsort' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runTsort(stdin: Uint8Array | null): Promise<{ out: string; exitCode: number }> {
  const resource = new RAMResource()
  const cmd = RAM_TSORT[0]
  if (cmd === undefined) throw new Error('tsort not registered')
  const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, [], [], {
    stdin,
    flags: {},
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
})
