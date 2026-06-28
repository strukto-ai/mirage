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
const RAM_COLUMN = RAM_COMMANDS.filter((c) => c.name === 'column' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runColumn(
  resource: RAMResource,
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]> = {},
  stdin: Uint8Array | null = null,
): Promise<{ out: string; exitCode: number }> {
  const cmd = RAM_COLUMN[0]
  if (cmd === undefined) throw new Error('column not registered')
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

describe('column', () => {
  it('-t pads into a table', async () => {
    const resource = new RAMResource()
    const r = await runColumn(resource, [], { t: true }, ENC.encode('name age\nAlice 30\nBob 25\n'))
    expect(r.exitCode).toBe(0)
    const lines = r.out.trim().split('\n')
    expect(lines.length).toBe(3)
  })

  it('passes through without -t', async () => {
    const resource = new RAMResource()
    const r = await runColumn(resource, [], {}, ENC.encode('a b\nc d\n'))
    expect(r.exitCode).toBe(0)
    expect(r.out).toBe('a b\nc d\n')
  })
})
