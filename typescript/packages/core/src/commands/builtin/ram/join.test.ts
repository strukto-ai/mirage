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
const RAM_JOIN = RAM_COMMANDS.filter((c) => c.name === 'join' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runJoin(
  resource: RAMResource,
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]> = {},
): Promise<{ out: string; exitCode: number }> {
  const cmd = RAM_JOIN[0]
  if (cmd === undefined) throw new Error('join not registered')
  const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, paths, [], {
    stdin: null,
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

describe('join', () => {
  it('joins two files on first field', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/a.txt', ENC.encode('1 Alice\n2 Bob\n'))
    resource.store.files.set('/b.txt', ENC.encode('1 NY\n2 LA\n'))
    const r = await runJoin(resource, [
      PathSpec.fromStrPath('/a.txt'),
      PathSpec.fromStrPath('/b.txt'),
    ])
    expect(r.exitCode).toBe(0)
    expect(r.out).toContain('1 Alice NY')
    expect(r.out).toContain('2 Bob LA')
  })

  it('returns exit 1 when fewer than 2 paths', async () => {
    const resource = new RAMResource()
    const r = await runJoin(resource, [])
    expect(r.exitCode).toBe(1)
  })
})
