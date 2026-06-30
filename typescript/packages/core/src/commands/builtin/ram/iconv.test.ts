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
const RAM_ICONV = RAM_COMMANDS.filter((c) => c.name === 'iconv' && c.filetype == null)

const ENC = new TextEncoder()

async function runIconv(
  resource: RAMResource,
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]> = {},
  stdin: Uint8Array | null = null,
): Promise<{ out: Uint8Array; exitCode: number }> {
  const cmd = RAM_ICONV[0]
  if (cmd === undefined) throw new Error('iconv not registered')
  const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, paths, [], {
    stdin,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource,
  })
  if (result === null) return { out: new Uint8Array(), exitCode: -1 }
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  return { out: buf, exitCode: ioResult.exitCode }
}

describe('iconv', () => {
  it('utf-8 to latin-1', async () => {
    const resource = new RAMResource()
    const input = ENC.encode('caf\u00e9\n')
    const r = await runIconv(resource, [], { f: 'utf-8', t: 'latin-1' }, input)
    expect(r.exitCode).toBe(0)
    const expected = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a])
    expect(Array.from(r.out)).toEqual(Array.from(expected))
  })
})
