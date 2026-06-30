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
import { gzip } from '../../../utils/compress.ts'
const RAM_ZCAT = RAM_COMMANDS.filter((c) => c.name === 'zcat' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runZcat(
  resource: RAMResource,
  paths: PathSpec[],
  stdin: Uint8Array | null = null,
): Promise<{ out: string; exitCode: number }> {
  const cmd = RAM_ZCAT[0]
  if (cmd === undefined) throw new Error('zcat not registered')
  const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, paths, [], {
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

describe('zcat', () => {
  it('decompresses a gzip file', async () => {
    const resource = new RAMResource()
    const compressed = await gzip(ENC.encode('hello world\n'))
    resource.store.files.set('/f.gz', compressed)
    const r = await runZcat(resource, [PathSpec.fromStrPath('/f.gz')])
    expect(r.exitCode).toBe(0)
    expect(r.out).toBe('hello world\n')
  })

  it('decompresses from stdin', async () => {
    const resource = new RAMResource()
    const compressed = await gzip(ENC.encode('stdin data\n'))
    const r = await runZcat(resource, [], compressed)
    expect(r.exitCode).toBe(0)
    expect(r.out).toBe('stdin data\n')
  })
})
