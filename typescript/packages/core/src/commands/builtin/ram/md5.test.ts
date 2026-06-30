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
import { md5Hex } from '../../../utils/hash.ts'
const RAM_MD5 = RAM_COMMANDS.filter((c) => c.name === 'md5' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runMd5(
  resource: RAMResource,
  paths: PathSpec[],
  stdin: Uint8Array | null = null,
): Promise<{ out: string; exitCode: number }> {
  const cmd = RAM_MD5[0]
  if (cmd === undefined) throw new Error('md5 not registered')
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

describe('md5', () => {
  it('matches md5Hex for a single file', async () => {
    const resource = new RAMResource()
    const data = ENC.encode('hello')
    resource.store.files.set('/tmp/f.txt', data)
    resource.store.dirs.add('/tmp')
    const expected = md5Hex(data)
    const r = await runMd5(resource, [PathSpec.fromStrPath('/tmp/f.txt')])
    expect(r.exitCode).toBe(0)
    expect(r.out).toBe(`${expected}  /tmp/f.txt\n`)
  })

  it('handles empty file', async () => {
    const resource = new RAMResource()
    const data = new Uint8Array()
    resource.store.files.set('/tmp/empty.txt', data)
    resource.store.dirs.add('/tmp')
    const expected = md5Hex(data)
    const r = await runMd5(resource, [PathSpec.fromStrPath('/tmp/empty.txt')])
    expect(r.exitCode).toBe(0)
    expect(r.out).toBe(`${expected}  /tmp/empty.txt\n`)
  })

  it('hashes stdin when no paths', async () => {
    const resource = new RAMResource()
    const data = ENC.encode('disk content')
    const expected = `${md5Hex(data)}  -\n`
    const r = await runMd5(resource, [], data)
    expect(r.exitCode).toBe(0)
    expect(r.out).toBe(expected)
  })

  it('hashes multiple files', async () => {
    const resource = new RAMResource()
    const d1 = ENC.encode('one')
    const d2 = ENC.encode('two')
    resource.store.files.set('/a.txt', d1)
    resource.store.files.set('/b.txt', d2)
    const r = await runMd5(resource, [
      PathSpec.fromStrPath('/a.txt'),
      PathSpec.fromStrPath('/b.txt'),
    ])
    expect(r.exitCode).toBe(0)
    expect(r.out).toBe(`${md5Hex(d1)}  /a.txt\n${md5Hex(d2)}  /b.txt\n`)
  })
})
