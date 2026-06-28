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
import type { RegisteredCommand } from '../../config.ts'
import { materialize } from '../../../io/types.ts'
import { RAMResource } from '../../../resource/ram/ram.ts'
import { PathSpec } from '../../../types.ts'
import { gzip as gzipUtil, gunzip as gunzipUtil } from '../../../utils/compress.ts'
const RAM_GZIP = RAM_COMMANDS.filter((c) => c.name === 'gzip' && c.filetype == null)
const RAM_GUNZIP = RAM_COMMANDS.filter((c) => c.name === 'gunzip' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runCmd(
  reg: readonly RegisteredCommand[],
  resource: RAMResource,
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]>,
  stdin: Uint8Array | null,
): Promise<{ out: Uint8Array; writes: Record<string, Uint8Array>; exitCode: number }> {
  const cmd = reg[0]
  if (cmd === undefined) throw new Error('not registered')
  const result = await cmd.fn(resource.accessor, paths, [], {
    stdin,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource,
  })
  if (result === null) return { out: new Uint8Array(), writes: {}, exitCode: 0 }
  const [output, io] = result as [unknown, { writes: Record<string, Uint8Array>; exitCode: number }]
  let outBytes: Uint8Array = new Uint8Array()
  if (output !== null) {
    outBytes =
      output instanceof Uint8Array ? output : await materialize(output as AsyncIterable<Uint8Array>)
  }
  return { out: outBytes, writes: io.writes, exitCode: io.exitCode }
}

describe('gzip / gunzip', () => {
  it('gzip from stdin produces gzip output', async () => {
    const resource = new RAMResource()
    const { out } = await runCmd(RAM_GZIP, resource, [], {}, ENC.encode('hello world'))
    const decompressed = await gunzipUtil(out)
    expect(DEC.decode(decompressed)).toBe('hello world')
  })

  it('gunzip from stdin decompresses', async () => {
    const resource = new RAMResource()
    const compressed = await gzipUtil(ENC.encode('hello world'))
    const { out } = await runCmd(RAM_GUNZIP, resource, [], {}, compressed)
    expect(DEC.decode(out)).toBe('hello world')
  })

  it('gzip -> gunzip round trip via stdin', async () => {
    const resource = new RAMResource()
    const { out: gz } = await runCmd(RAM_GZIP, resource, [], {}, ENC.encode('roundtrip test'))
    const { out: plain } = await runCmd(RAM_GUNZIP, resource, [], {}, gz)
    expect(DEC.decode(plain)).toBe('roundtrip test')
  })

  it('gzip on a file writes <path>.gz', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/f.txt', ENC.encode('test content'))
    const { writes } = await runCmd(RAM_GZIP, resource, [PathSpec.fromStrPath('/f.txt')], {}, null)
    expect(writes['/f.txt.gz']).toBeDefined()
  })

  it('gunzip on a file writes <path> without .gz', async () => {
    const resource = new RAMResource()
    const compressed = await gzipUtil(ENC.encode('original data'))
    resource.store.files.set('/f.txt.gz', compressed)
    const { writes } = await runCmd(
      RAM_GUNZIP,
      resource,
      [PathSpec.fromStrPath('/f.txt.gz')],
      {},
      null,
    )
    expect(writes['/f.txt']).toBeDefined()
    expect(DEC.decode(writes['/f.txt'])).toBe('original data')
  })
})
